import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { TrustedArtifactRegistry } from '../lib/desired-state-registry.mjs';
import { installRemoteArtifact, inspectRemoteArtifact, rollbackRemoteArtifact } from '../lib/remote-artifact-installer.mjs';
import { InstalledRuntimeManager, RuntimeSynchronizer, buildRuntimeSyncCommands, createBoundedAuthRunner, parseGrokDeviceAuthOutput } from '../lib/runtime-manager.mjs';
import { RemoteControlConnector } from '../lib/connector.mjs';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { FakeSessionControlPort } from '../lib/session-control-port.mjs';
import { TransportError, DshRemoteError } from '../lib/errors.mjs';
import { RuntimeManagerService } from '../lib/runtime-manager-service.mjs';

const execFile = promisify(execFileCallback);
const configuredSubagentRoot = process.env.DSH_SUBAGENT_CODE_AGENTS_ROOT;
if (configuredSubagentRoot !== undefined && !isAbsolute(configuredSubagentRoot)) throw new Error('DSH_SUBAGENT_CODE_AGENTS_ROOT must be an absolute path');
const DSH = '0.1.0-rc.6';
const API = '1.0';
const COMPATIBILITY = { dsh: { min: DSH, max: DSH }, api: { min: API, max: API } };

async function makeRuntimeArtifact(root, { id, version, driver = id, executablePath = `bin/${id.replaceAll('/', '-')}` }) {
  const sourceRoot = join(root, `${id.replaceAll('/', '-')}-${version}-source`);
  const packageRoot = join(sourceRoot, 'package');
  await mkdir(join(packageRoot, 'bin'), { recursive: true });
  const packageName = `dsh-runtime-${id.replaceAll('/', '-')}`;
  await writeFile(join(packageRoot, 'package.json'), `${JSON.stringify({ name: packageName, version, dsh: { runtime: { runtimeId: id, version, target: 'linux-x86_64', protocolVersion: '1.0', driver, executablePath } } }, null, 2)}\n`);
  const executable = join(packageRoot, ...executablePath.split('/'));
  await writeFile(executable, '#!/bin/sh\nprintf fake-runtime\n');
  await chmod(executable, 0o755);
  const artifactPath = join(root, `${packageName}-${version}.tgz`);
  await execFile('tar', ['-czf', artifactPath, '-C', sourceRoot, 'package']);
  const bytes = await readFile(artifactPath);
  return { id, version, driver, packageName, executablePath, artifactPath, size: (await stat(artifactPath)).size, sha256: createHash('sha256').update(bytes).digest('hex') };
}

function requirement(artifact, { requiredBy = ['project:runtime'] } = {}) {
  return { id: artifact.id, version: artifact.version, placement: 'remote', source: { registry: 'runtime-test', artifact: artifact.artifactPath.split(/[\\/]/u).pop() }, sha256: artifact.sha256, size: artifact.size, target: 'linux-x86_64', packageName: artifact.packageName, executablePath: artifact.executablePath, protocolVersion: '1.0', driver: artifact.driver, authPolicy: artifact.driver === 'grok-build' ? 'driver-defined' : 'remote-user', capabilities: ['headless'], compatibility: COMPATIBILITY, requiredBy };
}

function desired(runtimes) {
  return { dshVersion: DSH, apiVersion: API, plugins: [], skills: [], runtimes, defaultPermission: 'workspace-write', modelRoute: 'local-gateway-required' };
}

class LocalRuntimeTransport {
  constructor({ installRoot, daemon = null, linkType = process.platform === 'win32' ? 'junction' : 'dir' } = {}) {
    this.installRoot = installRoot;
    this.daemon = daemon;
    this.linkType = linkType;
    this.uploads = new Map();
    this.failInstallIds = new Set();
    this.dropRollbackResponse = false;
    this.dropCleanupResponse = false;
  }

  async request(message) { return this.daemon.handle(message); }

  async upload(localPath, remotePath, options) { this.uploads.set(remotePath, { localPath, options }); }

  async execArgv(argv) {
    if (argv[0] === 'mkdir' || argv[0] === 'rmdir') return { stdout: '', stderr: '', code: 0 };
    if (argv[0] === 'rm') {
      if (this.dropCleanupResponse) { this.dropCleanupResponse = false; throw new TransportError('fake cleanup response was lost after remote completion'); }
      return { stdout: '', stderr: '', code: 0 };
    }
    const id = argv[argv.indexOf('--id') + 1];
    if (argv.includes('--status') || argv.includes('--probe')) return { stdout: JSON.stringify(await inspectRemoteArtifact({ kind: 'runtime', id, installRoot: this.installRoot })), stderr: '', code: 0 };
    if (argv.includes('--rollback')) {
      const target = argv.includes('--target-missing')
        ? { status: 'missing' }
        : { status: 'installed', version: argv[argv.indexOf('--target-version') + 1], sha256: argv[argv.indexOf('--target-sha256') + 1], size: Number(argv[argv.indexOf('--target-size') + 1]), packageName: argv[argv.indexOf('--target-package-name') + 1], executablePath: argv[argv.indexOf('--target-executable-path') + 1], target: argv[argv.indexOf('--target') + 1], protocolVersion: argv[argv.indexOf('--protocol-version') + 1] };
      const result = await rollbackRemoteArtifact({ kind: 'runtime', id, installRoot: this.installRoot, target, linkType: this.linkType });
      if (this.dropRollbackResponse) { this.dropRollbackResponse = false; throw new TransportError('fake rollback response was lost after remote completion'); }
      return { stdout: JSON.stringify(result), stderr: '', code: 0 };
    }
    if (this.failInstallIds.has(id)) throw new DshRemoteError(`fake install failed for ${id}`, { code: 'RUNTIME_INSTALL_FAILED' });
    const remotePath = argv[argv.indexOf('--artifact') + 1];
    const uploaded = this.uploads.get(remotePath);
    const result = await installRemoteArtifact({ artifactPath: uploaded.localPath, kind: 'runtime', id, version: argv[argv.indexOf('--version') + 1], expectedSha256: argv[argv.indexOf('--sha256') + 1], installRoot: this.installRoot, packageName: argv[argv.indexOf('--package-name') + 1], executablePath: argv[argv.indexOf('--executable-path') + 1], protocolVersion: argv[argv.indexOf('--protocol-version') + 1], target: argv[argv.indexOf('--target') + 1], linkType: this.linkType });
    return { stdout: JSON.stringify(result), stderr: '', code: 0 };
  }
}

function makeRegistry(artifacts) {
  return new TrustedArtifactRegistry(artifacts.map((artifact) => ({ kind: 'runtime', ...requirement(artifact), artifactPath: artifact.artifactPath, manifest: { target: 'linux-x86_64', protocolVersion: '1.0', executablePath: artifact.executablePath } })));
}

test('runtime artifacts are installed on demand with absolute executable resolution and honest auth state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-manager-'));
  try {
    const codex = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...codex, kind: 'runtime', expectedSha256: codex.sha256, installRoot, linkType });
    const req = requirement(codex);
    const unverified = new InstalledRuntimeManager({ installRoot });
    const first = await unverified.inspect([req]);
    assert.equal(first[0].state, 'installed-auth-unverified');
    assert.match(first[0].executable, /bin[\\/]codex$/u);
    await assert.rejects(unverified.resolveExecutable(req), (error) => error.code === 'RUNTIME_AUTH_CONFIRMATION_REQUIRED');
    const challenge = await unverified.authChallenge(req);
    assert.equal(challenge.challenge.methods[0].id, 'codex-login');
    const authRequired = new InstalledRuntimeManager({ installRoot, authProbe: async () => ({ state: 'auth-required', auth: { status: 'expired', expiresAt: '2026-08-20T00:00:00.000Z' } }) });
    assert.equal((await authRequired.inspect([req]))[0].state, 'auth-required');
    const expiredReady = new InstalledRuntimeManager({ installRoot, authProbe: async () => ({ state: 'ready', auth: { status: 'ready', expiresAt: '2026-08-20T00:00:00.000Z' } }) });
    assert.equal((await expiredReady.inspect([req]))[0].state, 'auth-required');
    const ready = new InstalledRuntimeManager({ installRoot, authProbe: async () => ({ state: 'ready', auth: { status: 'ready' } }) });
    const executable = await ready.resolveExecutable(req);
    assert.equal(executable.state, 'ready');
    assert.equal(executable.runtime.id, 'codex');
    assert.equal((await stat(executable.executable)).isFile(), true);
    const claudeReq = requirement({ ...codex, id: 'claude-code', driver: 'claude-code', packageName: 'dsh-runtime-claude-code', executablePath: 'bin/claude-code' });
    assert.equal((await ready.inspect([claudeReq]))[0].state, 'missing');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('bounded auth runner executes only the supplied fixed argv and enforces output, timeout, and cancellation', async () => {
  const runner = createBoundedAuthRunner();
  const result = await runner([process.execPath, '-e', "process.stdout.write('https://auth.openai.com/device\\n')"], { timeoutMs: 5_000, maxStdoutBytes: 1_024, maxStderrBytes: 1_024 });
  assert.match(result.stdout, /auth\.openai\.com/u);
  await assert.rejects(runner([process.execPath, '-e', "process.stdout.write('x'.repeat(2_048))"], { timeoutMs: 5_000, maxStdoutBytes: 1_024 }), /exceeded limit/);
  await assert.rejects(runner([process.execPath, '-e', "setTimeout(() => {}, 10_000)"], { timeoutMs: 50 }), /timed out/);
  const controller = new AbortController();
  const pending = runner([process.execPath, '-e', "setTimeout(() => {}, 10_000)"], { timeoutMs: 5_000, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, /cancelled/);
});

test('managed auth returns a public device challenge before process exit and supports status, cancel, and daemon-close cleanup', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-auth-'));
  try {
    const req = requirement({ id: 'codex', version: '1.0.0', driver: 'codex', packageName: 'dsh-runtime-codex', executablePath: 'bin/codex', artifactPath: 'unused', size: 7, sha256: 'a'.repeat(64) });
    const status = { status: 'installed', kind: 'runtime', id: req.id, version: req.version, sha256: req.sha256, size: req.size, packageName: req.packageName, executablePath: req.executablePath, target: req.target, protocolVersion: req.protocolVersion, executable: process.execPath };
    const authRunner = createBoundedAuthRunner();
    const fakeDriver = {
      id: 'codex',
      authCommand: ['-e', "process.stdout.write('Open https://auth.openai.com/device\\nDevice code: ABCD-1234\\n'); setTimeout(() => {}, 30_000)"],
      authMethods: [{ id: 'codex-login', kind: 'browser', label: 'fake' }],
      permissions: [],
      capabilities: [],
      challenge({ executable, runtime }) { return { executable, runtimeId: runtime.id, methods: this.authMethods }; },
    };
    const manager = new InstalledRuntimeManager({ installRoot: root, transport: { execArgv: async () => ({ stdout: JSON.stringify(status), stderr: '', code: 0 }) }, authRunner, drivers: { codex: fakeDriver } });
    const started = await manager.authChallenge(req, { timeoutMs: 5_000 });
    assert.match(started.challenge.url, /^https:\/\/auth\.openai\.com\//u);
    assert.equal(started.challenge.userCode, 'ABCD-1234');
    assert.equal(started.status, 'running');
    const observed = await manager.authChallengeStatus(started.challengeId);
    assert.equal(observed.challengeId, started.challengeId);
    assert.equal(observed.status, 'running');
    assert.equal(observed.challenge.userCode, 'ABCD-1234');
    const cancelled = await manager.authChallengeCancel(started.challengeId);
    assert.equal(cancelled.status, 'cancelled');
    await assert.rejects(manager.authChallengeStatus('missing-challenge-id-1234'), (error) => error.code === 'RUNTIME_AUTH_CHALLENGE_UNKNOWN');

    const timeoutManager = new InstalledRuntimeManager({ installRoot: root, transport: { execArgv: async () => ({ stdout: JSON.stringify(status), stderr: '', code: 0 }) }, authRunner: createBoundedAuthRunner(), drivers: { codex: { ...fakeDriver, authCommand: ['-e', 'setTimeout(() => {}, 30_000)'] } } });
    const timedOut = await timeoutManager.authChallenge(req, { timeoutMs: 50 });
    assert.equal(timedOut.status, 'timed-out');
    assert.equal((await timeoutManager.authChallengeStatus(timedOut.challengeId)).status, 'timed-out');
    await timeoutManager.close();

    const marker = join(root, 'must-not-run-after-close');
    const closeDriver = { ...fakeDriver, authCommand: ['-e', `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'late'), 500)`] };
    const closingManager = new InstalledRuntimeManager({ installRoot: root, transport: { execArgv: async () => ({ stdout: JSON.stringify(status), stderr: '', code: 0 }) }, authRunner: createBoundedAuthRunner(), drivers: { codex: closeDriver } });
    await closingManager.authChallenge(req, { timeoutMs: 5_000 });
    await closingManager.close();
    await new Promise((resolve) => setTimeout(resolve, 700));
    await assert.rejects(readFile(marker));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote protocol exposes managed auth challenge status and cancellation after the public challenge is returned', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-auth-protocol-'));
  try {
    const req = requirement({ id: 'codex', version: '1.0.0', driver: 'codex', packageName: 'dsh-runtime-codex', executablePath: 'bin/codex', artifactPath: 'unused', size: 7, sha256: 'b'.repeat(64) });
    const status = { status: 'installed', kind: 'runtime', id: req.id, version: req.version, sha256: req.sha256, size: req.size, packageName: req.packageName, executablePath: req.executablePath, target: req.target, protocolVersion: req.protocolVersion, executable: process.execPath };
    const driver = { id: 'codex', authCommand: ['-e', "process.stdout.write('https://auth.openai.com/device Device code: EFGH-5678\\n'); setTimeout(() => {}, 30_000)"], authMethods: [{ id: 'codex-login', kind: 'browser', label: 'fake' }], permissions: [], capabilities: [], challenge({ executable, runtime }) { return { executable, runtimeId: runtime.id, methods: this.authMethods }; } };
    const manager = new InstalledRuntimeManager({ installRoot: root, transport: { execArgv: async () => ({ stdout: JSON.stringify(status), stderr: '', code: 0 }) }, authRunner: createBoundedAuthRunner(), drivers: { codex: driver } });
    const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort(), runtimeManager: manager });
    const connector = new RemoteControlConnector({ transport: { request: (message) => daemon.handle(message) }, sourceHostId: 'local-auth', sourceSessionId: 'auth-controller' });
    await connector.connect();
    const started = await connector.runtimeAuthChallenge(req, { timeoutMs: 5_000 });
    assert.equal(started.type, 'runtime.auth.challenge.result');
    assert.equal(started.result.challenge.userCode, 'EFGH-5678');
    const statusResponse = await connector.runtimeAuthChallengeStatus(started.result.challengeId);
    assert.equal(statusResponse.type, 'runtime.auth.status.result');
    assert.equal(statusResponse.result.challengeId, started.result.challengeId);
    const cancelled = await connector.runtimeAuthChallengeCancel(started.result.challengeId);
    assert.equal(cancelled.type, 'runtime.auth.cancel.result');
    assert.equal(cancelled.result.status, 'cancelled');
    await daemon.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime auth confirmation is a one-time target-session gate before project Session creation', { skip: configuredSubagentRoot === undefined }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-auth-gate-'));
  try {
    const codex = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const req = requirement(codex, { requiredBy: ['channel:codex'] });
    const registry = makeRegistry([codex]);
    const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort(), runtimeManager: new InstalledRuntimeManager({ installRoot }) });
    const transport = new LocalRuntimeTransport({ installRoot, daemon, linkType });
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const connector = new RemoteControlConnector({ transport, runtimeSynchronizer: synchronizer, sourceHostId: 'local', sourceSessionId: 'controller' });
    await connector.connect();
    const state = desired([req]);
    const first = await connector.openProject({ absolutePath: '/srv/runtime-auth-gate-1', desiredState: state });
    assert.equal(first.state, 'needs-attention');
    assert.equal(first.error.code, 'RUNTIME_REQUIREMENT_UNSATISFIED');
    assert.equal(daemon.sessionControl.calls.length, 0);
    const challenge = await connector.beginRuntimeAuth(req);
    await assert.rejects(connector.confirmRuntimeAuth({ challengeId: challenge.challengeId, nonce: 'wrong-nonce' }), /challenge is unknown|bound to another/);
    const otherConnector = new RemoteControlConnector({ transport, sourceHostId: 'local-2', sourceSessionId: 'other-controller' });
    await otherConnector.connect();
    await assert.rejects(otherConnector.confirmRuntimeAuth({ challengeId: challenge.challengeId, nonce: challenge.nonce }), /challenge is unknown|bound to another/);
    daemon.runtimeAuthChallenges.get(challenge.challengeId).expiresAt = new Date(Date.now() - 1).toISOString();
    await assert.rejects(connector.confirmRuntimeAuth({ challengeId: challenge.challengeId, nonce: challenge.nonce }), /challenge is unknown|bound to another/);
    const freshChallenge = await connector.beginRuntimeAuth(req);
    const ticket = await connector.confirmRuntimeAuth({ challengeId: freshChallenge.challengeId, nonce: freshChallenge.nonce });
    await assert.rejects(connector.confirmRuntimeAuth({ challengeId: freshChallenge.challengeId, nonce: freshChallenge.nonce }), /challenge is unknown|bound to another/);
    const second = await connector.openProject({ absolutePath: '/srv/runtime-auth-gate-2', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId } });
    assert.equal(second.state, 'completed');
    const targetSessionId = second.result.sessionId;
    const service = new RuntimeManagerService({ daemon, hostId: daemon.hostState.host.hostId, capabilityToken: 'C'.repeat(32) });
    const serviceFrame = { id: 'runtime-resolve-1', hostId: daemon.hostState.host.hostId, targetHostId: daemon.hostState.host.hostId, sourceHostId: 'local', sourceSessionId: 'controller', capabilityToken: 'C'.repeat(32), message: { type: 'runtime-manager.resolve', targetSessionId, requirement: req } };
    const throughService = await service.handle(serviceFrame);
    assert.equal(throughService.result.authConfirmed, true);
    assert.match(throughService.result.executable, /^(?:[A-Za-z]:[\\/]|\/)/u);
    const throughServiceAgain = await service.handle({ ...serviceFrame, id: 'runtime-resolve-2' });
    assert.equal(throughServiceAgain.result.executable, throughService.result.executable);
    const { resolveCodexEntry } = await import(pathToFileURL(join(configuredSubagentRoot, 'packages', 'channel-codex', 'lib', 'index.js')).href);
    const channelResolved = await resolveCodexEntry({ runtimeManager: { resolveExecutable: async (runtimeRequirement, context) => { const response = await service.handle({ ...serviceFrame, id: `runtime-channel-${Date.now()}`, message: { ...serviceFrame.message, requirement: runtimeRequirement, targetSessionId: context.targetSessionId } }); return response.result; } }, executionPolicy: { targetSessionId } }, { runtimeRequirement: req });
    assert.equal(channelResolved.executable, throughService.result.executable);
    assert.equal(daemon.sessionControl.calls.length, 1);
    const launched = await daemon.runtimeManager.resolveExecutable(req, { sourceSessionId: 'controller', targetSessionId });
    assert.equal(launched.authConfirmed, true);
    const repeated = await daemon.runtimeManager.resolveExecutable(req, { sourceSessionId: 'controller', targetSessionId });
    assert.equal(repeated.authConfirmed, true);
    const leasedEnsure = await daemon.runtimeManager.ensure([req], { runtimeSync: second.result.runtimeSync, sourceSessionId: 'controller', targetSessionId: targetSessionId });
    assert.equal(leasedEnsure.ok, true);
    assert.equal(leasedEnsure.states[0].authConfirmation, 'leased');
    assert.equal(leasedEnsure.requiresFirstCallConfirmation, false);
    const reopened = await connector.openProject({ absolutePath: '/srv/runtime-auth-gate-2', targetSessionId, desiredState: state, idempotencyKey: 'runtime-auth-reopen-with-lease' });
    assert.equal(reopened.state, 'completed');
    const crossTargetEnsure = await daemon.runtimeManager.ensure([req], { runtimeSync: second.result.runtimeSync, sourceSessionId: 'controller', targetSessionId: 'other-target' });
    assert.equal(crossTargetEnsure.ok, false);
    assert.equal(crossTargetEnsure.states[0].authConfirmation, 'required');
    assert.equal(crossTargetEnsure.requiresFirstCallConfirmation, true);
    for (const lease of daemon.runtimeManager.authLeases.values()) lease.expiresAt = new Date(Date.now() - 1).toISOString();
    const expiredEnsure = await daemon.runtimeManager.ensure([req], { runtimeSync: second.result.runtimeSync, sourceSessionId: 'controller', targetSessionId });
    assert.equal(expiredEnsure.ok, false);
    assert.equal(expiredEnsure.states[0].authConfirmation, 'required');
    assert.equal(expiredEnsure.requiresFirstCallConfirmation, true);
    const driftEnsure = await daemon.runtimeManager.ensure([{ ...req, sha256: 'b'.repeat(64) }], { runtimeSync: second.result.runtimeSync, sourceSessionId: 'controller', targetSessionId });
    assert.equal(driftEnsure.ok, false);
    assert.equal(driftEnsure.states[0].state, 'update-required');
    await assert.rejects(daemon.runtimeManager.resolveExecutable({ ...req, sha256: 'b'.repeat(64) }, { sourceSessionId: 'controller', targetSessionId }), (error) => error.code === 'RUNTIME_AUTH_CONFIRMATION_REQUIRED' || error.code === 'RUNTIME_NOT_READY');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime auth ticket survives an unknown project.open terminal and retries through the same Session Control idempotency key', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-auth-unknown-open-'));
  try {
    const codex = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const req = requirement(codex, { requiredBy: ['channel:codex'] });
    const registry = makeRegistry([codex]);
    class LostResponseSessionControl extends FakeSessionControlPort {
      constructor() { super(); this.openAttempts = 0; }
      async openProject(request, context) {
        this.openAttempts += 1;
        const result = await super.openProject(request, context);
        if (this.openAttempts === 1) throw new DshRemoteError('Session Control response was lost after durable open', { code: 'TRANSPORT_ERROR', unknownTerminal: true });
        return result;
      }
    }
    const sessionControl = new LostResponseSessionControl();
    const daemon = await RemoteHostDaemon.create({ sessionControl, runtimeManager: new InstalledRuntimeManager({ installRoot }) });
    const transport = new LocalRuntimeTransport({ installRoot, daemon, linkType });
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const connector = new RemoteControlConnector({ transport, runtimeSynchronizer: synchronizer, sourceHostId: 'local', sourceSessionId: 'controller' });
    await connector.connect();
    const state = desired([req]);
    const challenge = await connector.beginRuntimeAuth(req);
    const ticket = await connector.confirmRuntimeAuth({ challengeId: challenge.challengeId, nonce: challenge.nonce });
    const first = await connector.openProject({ absolutePath: '/srv/runtime-auth-unknown', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId }, idempotencyKey: 'runtime-auth-unknown-open' });
    assert.equal(first.state, 'needs-attention');
    assert.equal(first.error.code, 'TRANSPORT_ERROR');
    assert.equal(daemon.runtimeAuthTickets.has(ticket.ticketId), true);
    const second = await connector.openProject({ absolutePath: '/srv/runtime-auth-unknown', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId }, idempotencyKey: 'runtime-auth-unknown-open' });
    assert.equal(second.state, 'completed');
    assert.equal(sessionControl.openAttempts, 2);
    assert.equal(sessionControl.projects.size, 1);
    assert.equal(daemon.runtimeAuthTickets.has(ticket.ticketId), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime auth reservations are isolated by source and operation and cannot be stolen by a second project', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-auth-reservation-isolation-'));
  try {
    const codex = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const req = requirement(codex, { requiredBy: ['channel:codex'] });
    const registry = makeRegistry([codex]);
    class LostResponseSessionControl extends FakeSessionControlPort {
      constructor() { super(); this.openAttempts = 0; }
      async openProject(request, context) {
        this.openAttempts += 1;
        const result = await super.openProject(request, context);
        if (this.openAttempts === 1) throw new DshRemoteError('response lost after durable open', { code: 'TRANSPORT_ERROR', unknownTerminal: true });
        return result;
      }
    }
    const sessionControl = new LostResponseSessionControl();
    const daemon = await RemoteHostDaemon.create({ sessionControl, runtimeManager: new InstalledRuntimeManager({ installRoot }) });
    const transport = new LocalRuntimeTransport({ installRoot, daemon, linkType });
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const a = new RemoteControlConnector({ transport, runtimeSynchronizer: synchronizer, sourceHostId: 'source-a', sourceSessionId: 'controller-a' });
    const b = new RemoteControlConnector({ transport, runtimeSynchronizer: synchronizer, sourceHostId: 'source-b', sourceSessionId: 'controller-b' });
    await a.connect();
    await b.connect();
    const state = desired([req]);
    const challenge = await a.beginRuntimeAuth(req);
    const ticket = await a.confirmRuntimeAuth({ challengeId: challenge.challengeId, nonce: challenge.nonce });
    const first = await a.openProject({ absolutePath: '/srv/reservation-a', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId }, idempotencyKey: 'reservation-a' });
    assert.equal(first.state, 'needs-attention');
    const stolenByOtherProject = await a.openProject({ absolutePath: '/srv/reservation-b', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId }, idempotencyKey: 'reservation-b' });
    assert.equal(stolenByOtherProject.state, 'needs-attention');
    assert.equal(stolenByOtherProject.error.code, 'RUNTIME_AUTH_TICKET_INVALID');
    const stolenByOtherSource = await b.openProject({ absolutePath: '/srv/reservation-c', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId }, idempotencyKey: 'reservation-c' });
    assert.equal(stolenByOtherSource.state, 'needs-attention');
    assert.equal(stolenByOtherSource.error.code, 'RUNTIME_AUTH_TICKET_INVALID');
    const noTicket = await b.openProject({ absolutePath: '/srv/reservation-d', desiredState: state, idempotencyKey: 'reservation-d' });
    assert.equal(noTicket.state, 'needs-attention');
    assert.equal(noTicket.error.code, 'RUNTIME_REQUIREMENT_UNSATISFIED');
    assert.equal(sessionControl.openAttempts, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('reserved runtime auth survives daemon restart and an expired interactive ticket, then commits the same Session Control result', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-auth-restart-'));
  const dataDir = join(root, 'state');
  try {
    const codex = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    const req = requirement(codex, { requiredBy: ['channel:codex'] });
    const registry = makeRegistry([codex]);
    class LostResponseSessionControl extends FakeSessionControlPort {
      constructor() { super(); this.openAttempts = 0; }
      async openProject(request, context) {
        this.openAttempts += 1;
        const result = await super.openProject(request, context);
        if (this.openAttempts === 1) throw new DshRemoteError('response lost after durable Session Control open', { code: 'TRANSPORT_ERROR', unknownTerminal: true });
        return result;
      }
    }
    const sessionControl = new LostResponseSessionControl();
    const daemon = await RemoteHostDaemon.create({ dataDir, sessionControl, runtimeManager: new InstalledRuntimeManager({ installRoot }), hostId: 'persistent-remote-host' });
    const transport = new LocalRuntimeTransport({ installRoot, daemon, linkType });
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const connector = new RemoteControlConnector({ transport, runtimeSynchronizer: synchronizer, sourceHostId: 'local', sourceSessionId: 'controller' });
    await connector.connect();
    const state = desired([req]);
    const challenge = await connector.beginRuntimeAuth(req);
    const ticket = await connector.confirmRuntimeAuth({ challengeId: challenge.challengeId, nonce: challenge.nonce });
    const first = await connector.openProject({ absolutePath: '/srv/runtime-auth-restart', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId }, idempotencyKey: 'runtime-auth-restart-open' });
    assert.equal(first.state, 'needs-attention');
    assert.equal(daemon.hostState.authReservations[ticket.ticketId].sessionControlAttempted, true);
    assert.equal(Object.hasOwn(daemon.hostState.authReservations[ticket.ticketId], 'token'), false);
    assert.equal(Object.hasOwn(daemon.hostState.authReservations[ticket.ticketId], 'credential'), false);
    await daemon.store.update((stateValue) => {
      stateValue.authReservations[ticket.ticketId].expiresAt = new Date(Date.now() - 1).toISOString();
    });
    await daemon.close();
    const restarted = await RemoteHostDaemon.create({ dataDir, sessionControl, runtimeManager: new InstalledRuntimeManager({ installRoot }), hostId: 'persistent-remote-host' });
    transport.daemon = restarted;
    await connector.connect();
    const second = await connector.openProject({ absolutePath: '/srv/runtime-auth-restart', desiredState: state, runtimeAuthTickets: { codex: ticket.ticketId }, idempotencyKey: 'runtime-auth-restart-open' });
    assert.equal(second.state, 'completed');
    assert.equal(second.result.sessionId, 'session-1');
    assert.equal(sessionControl.openAttempts, 2);
    assert.equal(restarted.runtimeAuthTickets.has(ticket.ticketId), false);
    assert.equal(restarted.hostState.authReservations[ticket.ticketId].status, 'consumed');
    await restarted.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime synchronizer installs only requested channels and preserves prior version on multi-runtime failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-sync-'));
  try {
    const codexOld = await makeRuntimeArtifact(root, { id: 'codex', version: '1.0.0' });
    const codexNew = await makeRuntimeArtifact(root, { id: 'codex', version: '1.1.0' });
    const claude = await makeRuntimeArtifact(root, { id: 'claude-code', version: '1.0.0' });
    const registry = makeRegistry([codexNew, claude]);
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...codexOld, kind: 'runtime', expectedSha256: codexOld.sha256, installRoot, linkType });
    const daemon = await RemoteHostDaemon.create({ sessionControl: new FakeSessionControlPort() });
    const transport = new LocalRuntimeTransport({ installRoot, daemon, linkType });
    transport.failInstallIds.add('claude-code');
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const connector = new RemoteControlConnector({ transport, runtimeSynchronizer: synchronizer, sourceHostId: 'local', sourceSessionId: 'controller' });
    await connector.connect();
    const result = await connector.openProject({ absolutePath: '/srv/runtime-failure', desiredState: desired([requirement(codexNew), requirement(claude)]) });
    assert.equal(result.state, 'needs-attention');
    assert.equal(result.error.code, 'RUNTIME_SYNC_NEEDS_ATTENTION');
    assert.equal(result.result.runtimeSync.rollback.status, 'completed');
    assert.equal((await inspectRemoteArtifact({ kind: 'runtime', id: 'codex', installRoot })).version, '1.0.0');
    assert.equal((await stat(join(installRoot, 'runtimes', 'codex', 'versions', '1.0.0'))).isDirectory(), true);
    assert.equal((await stat(join(installRoot, 'runtimes', 'codex', 'versions', '1.1.0'))).isDirectory(), true);
    assert.equal((await inspectRemoteArtifact({ kind: 'runtime', id: 'claude-code', installRoot })).status, 'missing');
    assert.equal(daemon.sessionControl.calls.length, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime rollback response loss becomes persistence-unknown and stable status reconciles completed rollback', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-runtime-unknown-'));
  try {
    const oldRuntime = await makeRuntimeArtifact(root, { id: 'grok-build', version: '1.0.0' });
    const newRuntime = await makeRuntimeArtifact(root, { id: 'grok-build', version: '1.1.0' });
    const registry = makeRegistry([newRuntime]);
    const installRoot = join(root, 'remote');
    const linkType = process.platform === 'win32' ? 'junction' : 'dir';
    await installRemoteArtifact({ ...oldRuntime, kind: 'runtime', expectedSha256: oldRuntime.sha256, installRoot, linkType });
    const transport = new LocalRuntimeTransport({ installRoot, linkType });
    transport.dropCleanupResponse = true;
    transport.dropRollbackResponse = true;
    const synchronizer = new RuntimeSynchronizer({ registry, transport, remoteRoot: '/home/test/.dsh-remote' });
    const result = await synchronizer.sync({ desiredState: desired([requirement(newRuntime)]), operationId: 'runtime-unknown-001' });
    assert.equal(result.status, 'persistence-unknown');
    assert.equal(result.rollback.status, 'unknown');
    const reconciled = await synchronizer.reconcile('runtime-unknown-001');
    assert.equal(reconciled.status, 'needs-attention');
    assert.equal(reconciled.rollback.status, 'completed');
    assert.equal((await inspectRemoteArtifact({ kind: 'runtime', id: 'grok-build', installRoot })).version, '1.0.0');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('runtime command builder exposes no shell and keeps target executable path explicit', () => {
  const commands = buildRuntimeSyncCommands({ id: 'acp/example', version: '1.0.0', sha256: 'a'.repeat(64), size: 10, packageName: 'dsh-runtime-acp-example', executablePath: 'bin/agent', protocolVersion: '1.0', remoteRoot: '/home/test/.dsh-remote', remoteStagingRoot: '/home/test/.dsh-remote/staging', remoteArtifactPath: '/home/test/.dsh-remote/staging/a.tgz', installerPath: '/home/test/.dsh-remote/current/bin/dsh-remote-artifact-installer.mjs' });
  assert.equal(commands.install.includes('sh'), false);
  assert.equal(commands.install[commands.install.indexOf('--executable-path') + 1], 'bin/agent');
  assert.equal(commands.rollback({ status: 'missing' }).includes('--target-missing'), true);
});

test('Grok device auth output exposes only public URL and device code', () => {
  const parsed = parseGrokDeviceAuthOutput('Open https://auth.x.ai/device to continue\nDevice code: AB12-CD34\naccess_token=must-not-escape');
  assert.deepEqual(parsed, { url: 'https://auth.x.ai/device', userCode: 'AB12-CD34' });
});

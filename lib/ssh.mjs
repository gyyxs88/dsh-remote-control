import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DshRemoteError, TimeoutError, TransportError } from './errors.mjs';
import { validateSafePosixPath } from './path-safety.mjs';

const SAFE_HOST = /^[A-Za-z0-9_.@:%\[\]-]+$/u;
const SAFE_COMMAND = /^[A-Za-z0-9_./:-]+$/u;
const ALLOWED_EXTRA_FLAGS = new Set(['-N', '-T', '-o', '-R']);
const ALLOWED_SSH_OPTIONS = new Set(['ExitOnForwardFailure=yes']);

export function quotePosixArg(value) {
  if (typeof value !== 'string' || value.includes('\0')) throw new DshRemoteError('SSH argv contains NUL', { code: 'SSH_ARG_INVALID' });
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function validateHost(host) {
  if (typeof host !== 'string' || host.length === 0 || host.startsWith('-') || !SAFE_HOST.test(host)) throw new DshRemoteError('SSH host is unsafe or can inject an option', { code: 'SSH_HOST_INVALID' });
}

function validateExtraArgs(extraArgs) {
  if (!Array.isArray(extraArgs)) throw new DshRemoteError('SSH extraArgs must be an argv array', { code: 'SSH_ARGS_INVALID' });
  for (let index = 0; index < extraArgs.length; index += 1) {
    const value = extraArgs[index];
    if (typeof value !== 'string' || /[\0\r\n]/u.test(value)) throw new DshRemoteError('SSH extraArgs contains unsafe data', { code: 'SSH_ARGS_INVALID' });
    if (value.startsWith('-')) {
      if (!ALLOWED_EXTRA_FLAGS.has(value)) throw new DshRemoteError('SSH extra option is not allowlisted', { code: 'SSH_ARGS_NOT_ALLOWED', details: { value } });
      if (value === '-o') {
        const option = extraArgs[++index];
        if (!ALLOWED_SSH_OPTIONS.has(option)) throw new DshRemoteError('SSH -o option is not allowlisted', { code: 'SSH_ARGS_NOT_ALLOWED', details: { option } });
      } else if (value === '-R') {
        const forward = extraArgs[++index];
        if (!/^127\.0\.0\.1:\d+:127\.0\.0\.1:\d+$/u.test(forward ?? '')) throw new DshRemoteError('SSH reverse forward is not loopback-only', { code: 'SSH_TUNNEL_BIND_INVALID' });
      }
    } else if (!/^[A-Za-z0-9_.=:+/@%-]+$/u.test(value)) {
      throw new DshRemoteError('SSH extra argument contains shell metacharacters', { code: 'SSH_ARGS_INVALID' });
    }
  }
  return extraArgs;
}

function parseExpectedPublicKey(value) {
  if (!value) return null;
  const parts = value.trim().split(/\s+/u);
  if (parts.length < 2 || !/^\S+$/.test(parts[0]) || !/^[A-Za-z0-9+/=]+$/.test(parts[1])) throw new DshRemoteError('expectedPublicKey must contain key type and base64 key', { code: 'SSH_HOST_KEY_PIN_INVALID' });
  return { type: parts[0], data: parts[1] };
}

export function validateSshHostKeyPolicy(policy = {}) {
  if (!policy.knownHostsFile || !isAbsolute(policy.knownHostsFile)) throw new DshRemoteError('SSH requires an absolute known_hosts file', { code: 'SSH_HOST_KEY_POLICY_REQUIRED' });
  if (!policy.hostKeyAlias || !SAFE_HOST.test(policy.hostKeyAlias)) throw new DshRemoteError('SSH hostKeyAlias is unsafe', { code: 'SSH_HOST_KEY_POLICY_REQUIRED' });
  if (!policy.expectedFingerprint && !policy.expectedPublicKey) throw new DshRemoteError('SSH requires a pinned host-key fingerprint or public key', { code: 'SSH_HOST_KEY_PIN_REQUIRED' });
  if (policy.expectedFingerprint && !/^SHA256:[A-Za-z0-9+/]+$/u.test(policy.expectedFingerprint)) throw new DshRemoteError('SSH host-key fingerprint must be an OpenSSH SHA256 fingerprint', { code: 'SSH_HOST_KEY_PIN_INVALID' });
  parseExpectedPublicKey(policy.expectedPublicKey);
  return {
    knownHostsFile: resolve(policy.knownHostsFile),
    hostKeyAlias: policy.hostKeyAlias,
    expectedFingerprint: policy.expectedFingerprint ?? null,
    expectedPublicKey: policy.expectedPublicKey ?? null,
  };
}

export function verifyPinnedHostKeySync(policy) {
  const pin = validateSshHostKeyPolicy(policy);
  let content;
  try {
    const info = lstatSync(pin.knownHostsFile);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('known_hosts must be a regular file');
    content = readFileSync(pin.knownHostsFile, 'utf8');
  } catch (error) {
    throw new DshRemoteError('pinned known_hosts file is unavailable', { code: 'SSH_HOST_KEY_FILE_INVALID', details: { message: error.message } });
  }
  const expected = parseExpectedPublicKey(pin.expectedPublicKey);
  const matches = [];
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) continue;
    const parts = trimmed.split(/\s+/u);
    if (parts.length < 3 || !parts[0].split(',').includes(pin.hostKeyAlias)) continue;
    matches.push({ type: parts[1], data: parts[2] });
  }
  if (matches.length === 0) throw new DshRemoteError('known_hosts has no entry for the pinned HostKeyAlias', { code: 'SSH_HOST_KEY_NOT_FOUND', details: { hostKeyAlias: pin.hostKeyAlias } });
  if (matches.length !== 1) throw new DshRemoteError('known_hosts has multiple entries for the pinned HostKeyAlias', { code: 'SSH_HOST_KEY_AMBIGUOUS', details: { hostKeyAlias: pin.hostKeyAlias } });
  const match = matches[0];
  if (!/^[A-Za-z0-9+/=]+$/u.test(match.data)) throw new DshRemoteError('known_hosts public key encoding is invalid', { code: 'SSH_HOST_KEY_FILE_INVALID' });
  if (expected && (expected.type !== match.type || expected.data !== match.data)) throw new DshRemoteError('known_hosts public key does not match the configured pin', { code: 'SSH_HOST_KEY_MISMATCH' });
  if (pin.expectedFingerprint) {
    const fingerprint = `SHA256:${createHash('sha256').update(Buffer.from(match.data, 'base64')).digest('base64').replace(/=+$/u, '')}`;
    if (fingerprint !== pin.expectedFingerprint) throw new DshRemoteError('known_hosts key fingerprint does not match the configured pin', { code: 'SSH_HOST_KEY_MISMATCH', details: { fingerprint } });
  }
  return { ...pin, keyType: match.type, fingerprint: `SHA256:${createHash('sha256').update(Buffer.from(match.data, 'base64')).digest('base64').replace(/=+$/u, '')}` };
}

export function buildStrictSshArgs({ policy, host, remoteCommand = [], extraArgs = [] } = {}) {
  const pin = verifyPinnedHostKeySync(policy);
  validateHost(host);
  if (!Array.isArray(remoteCommand) || remoteCommand.some((value) => typeof value !== 'string' || /[\0\r\n]/u.test(value))) throw new DshRemoteError('SSH remote command must be a safe argv array', { code: 'SSH_COMMAND_INVALID' });
  validateExtraArgs(extraArgs);
  const args = ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${pin.knownHostsFile}`, '-o', `HostKeyAlias=${pin.hostKeyAlias}`, ...extraArgs, host];
  if (remoteCommand.length > 0) args.push(remoteCommand.map(quotePosixArg).join(' '));
  return args;
}

export function buildStdioBridgeArgs({ policy, host, command = 'dsh-remote-host', dataDir, extraArgs = [] } = {}) {
  if (typeof command !== 'string' || !SAFE_COMMAND.test(command)) throw new DshRemoteError('Remote bridge command is unsafe', { code: 'SSH_COMMAND_INVALID' });
  validateSafePosixPath(dataDir, { field: 'remote dataDir', allowHome: false });
  return buildStrictSshArgs({ policy, host, remoteCommand: [command, 'bridge', '--stdio', '--data-dir', dataDir], extraArgs });
}

export function buildReverseTunnelArgs({ policy, host, localPort, remotePort, bindAddress = '127.0.0.1', gatewayHost = '127.0.0.1', extraArgs = [] } = {}) {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) throw new DshRemoteError('reverse tunnel ports must be valid TCP ports', { code: 'SSH_TUNNEL_PORT_INVALID' });
  if (bindAddress !== '127.0.0.1' || gatewayHost !== '127.0.0.1') throw new DshRemoteError('reverse tunnel must bind loopback on both sides', { code: 'SSH_TUNNEL_BIND_INVALID' });
  return buildStrictSshArgs({ policy, host, extraArgs: ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-R', `${bindAddress}:${remotePort}:${gatewayHost}:${localPort}`, ...extraArgs] });
}

function runChild(command, args, { spawnImpl, timeoutMs, maxOutputBytes, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => { if (settled) return; settled = true; clearTimeout(timer); if (error && !child.killed) child.kill(); if (error) reject(error); else resolve(result); };
    const timer = setTimeout(() => { child.kill(); finish(new TimeoutError('SSH command timed out', { command, args })); }, timeoutMs);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > maxOutputBytes) finish(new DshRemoteError('SSH stdout exceeded limit', { code: 'SSH_OUTPUT_TOO_LARGE' })); });
    child.stderr.on('data', (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > maxOutputBytes) finish(new DshRemoteError('SSH stderr exceeded limit', { code: 'SSH_OUTPUT_TOO_LARGE' })); });
    child.on('error', (error) => finish(new TransportError('SSH process failed to start', { message: error.message })));
    child.on('exit', (code, signal) => code === 0 ? finish(null, { code, signal, stdout, stderr }) : finish(new TransportError('SSH command failed', { code, signal, stdout, stderr, command, args })));
    if (input !== null) child.stdin.end(input); else child.stdin.end();
  });
}

export class SshCommandTransport {
  constructor({ sshPath = 'ssh', scpPath = 'scp', policy, host, commandTimeoutMs = 30_000, maxOutputBytes = 512 * 1024, spawnImpl = spawn } = {}) {
    if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 1 || !Number.isInteger(maxOutputBytes) || maxOutputBytes < 1) throw new DshRemoteError('SSH transport limits are invalid', { code: 'SSH_TRANSPORT_LIMIT_INVALID' });
    this.sshPath = sshPath; this.scpPath = scpPath; this.policy = policy; this.host = host; this.commandTimeoutMs = commandTimeoutMs; this.maxOutputBytes = maxOutputBytes; this.spawnImpl = spawnImpl;
  }

  execArgv(remoteCommand) {
    return runChild(this.sshPath, buildStrictSshArgs({ policy: this.policy, host: this.host, remoteCommand }), { spawnImpl: this.spawnImpl, timeoutMs: this.commandTimeoutMs, maxOutputBytes: this.maxOutputBytes });
  }

  upload(localPath, remotePath) {
    if (typeof localPath !== 'string' || localPath.length === 0 || localPath.startsWith('-') || /[\0\r\n]/u.test(localPath)) throw new DshRemoteError('local artifact path is unsafe', { code: 'SSH_UPLOAD_PATH_INVALID' });
    validateSafePosixPath(remotePath, { field: 'remote upload path' });
    const args = buildStrictSshArgs({ policy: this.policy, host: this.host }).slice(0, -1);
    args.push(localPath, `${this.host}:${quotePosixArg(remotePath)}`);
    return runChild(this.scpPath, ['-T', ...args], { spawnImpl: this.spawnImpl, timeoutMs: this.commandTimeoutMs, maxOutputBytes: this.maxOutputBytes });
  }
}

export class SshStdioBridge {
  constructor({ sshPath = 'ssh', policy, host, command, dataDir, spawnImpl = spawn, requestTimeoutMs = 30_000, maxFrameBytes = 256 * 1024, maxPending = 64 } = {}) {
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1 || !Number.isInteger(maxFrameBytes) || maxFrameBytes < 1024 || !Number.isInteger(maxPending) || maxPending < 1) throw new DshRemoteError('SSH bridge limits are invalid', { code: 'SSH_BRIDGE_LIMIT_INVALID' });
    this.sshPath = sshPath; this.policy = policy; this.host = host; this.command = command; this.dataDir = dataDir; this.spawnImpl = spawnImpl; this.requestTimeoutMs = requestTimeoutMs; this.maxFrameBytes = maxFrameBytes; this.maxPending = maxPending;
    this.child = null; this.pending = new Map(); this.buffer = ''; this.nextRequestId = 1; this.protocolErrors = 0;
  }

  async start() {
    if (this.child) return;
    const args = buildStdioBridgeArgs({ policy: this.policy, host: this.host, command: this.command, dataDir: this.dataDir });
    this.child = this.spawnImpl(this.sshPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.on('error', (error) => this.#reset(new TransportError('SSH stdio bridge failed', { message: error.message })));
    this.child.on('exit', (code, signal) => this.#reset(new DshRemoteError('SSH stdio bridge exited', { code: 'SSH_BRIDGE_EXITED', details: { code, signal } })));
  }

  async request(message) {
    await this.start();
    const child = this.child;
    if (!child) throw new DshRemoteError('SSH stdio bridge exited before the request was sent', { code: 'SSH_BRIDGE_EXITED' });
    if (this.pending.size >= this.maxPending) throw new DshRemoteError('SSH bridge pending request limit reached', { code: 'SSH_PENDING_LIMIT' });
    const id = String(this.nextRequestId++);
    const payload = `${JSON.stringify({ id, message })}\n`;
    if (Buffer.byteLength(payload, 'utf8') > this.maxFrameBytes) throw new DshRemoteError('SSH bridge request exceeded frame limit', { code: 'SSH_BRIDGE_FRAME_TOO_LARGE' });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new TimeoutError('SSH bridge request timed out', { id, type: message?.type })); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      try { child.stdin.write(payload); } catch (error) { this.pending.get(id)?.reject(new TransportError('SSH bridge write failed', { message: error.message })); this.pending.delete(id); }
    });
  }

  close() { this.#reset(new DshRemoteError('SSH bridge closed', { code: 'SSH_BRIDGE_CLOSED' })); }

  #onData(chunk) {
    this.buffer += chunk;
    if ((this.buffer.indexOf('\n') < 0 && Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes) || Buffer.byteLength(this.buffer, 'utf8') > this.maxFrameBytes * this.maxPending) { this.protocolErrors += 1; this.#reset(new DshRemoteError('SSH bridge frame buffer exceeded limit', { code: 'SSH_BRIDGE_FRAME_TOO_LARGE' })); return; }
    while (true) {
      const index = this.buffer.indexOf('\n'); if (index < 0) break;
      const line = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1); if (Buffer.byteLength(line, 'utf8') > this.maxFrameBytes) { this.protocolErrors += 1; this.#reset(new DshRemoteError('SSH bridge frame exceeded limit', { code: 'SSH_BRIDGE_FRAME_TOO_LARGE' })); return; } if (!line.trim()) continue;
      let frame; try { frame = JSON.parse(line); } catch { this.protocolErrors += 1; this.#reset(new DshRemoteError('SSH bridge returned invalid JSON', { code: 'SSH_BRIDGE_PROTOCOL_ERROR' })); return; }
      const pending = this.pending.get(String(frame.id));
      if (!pending) { this.protocolErrors += 1; continue; }
      this.pending.delete(String(frame.id));
      if (frame.error) pending.reject(new DshRemoteError(frame.error.message ?? 'remote bridge error', frame.error)); else pending.resolve(frame.response);
    }
  }

  #reset(error) {
    const child = this.child; this.child = null; this.buffer = '';
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    if (child && !child.killed) child.kill();
  }
}

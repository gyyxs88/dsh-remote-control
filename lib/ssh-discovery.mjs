import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { DshRemoteError, TimeoutError, TransportError } from './errors.mjs';

const SAFE_TARGET = /^[A-Za-z0-9_.@:%\[\]-]+$/u;
const SAFE_HOSTNAME = /^[A-Za-z0-9_.:%\[\]-]+$/u;
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]+$/u;
const KEY_TYPES = new Set(['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa']);

function boundedProcess(command, args, { spawnImpl = spawn, timeoutMs = 10_000, maxOutputBytes = 256 * 1024, allowNonZero = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error && !child.killed) child.kill();
      if (error) reject(error);
      else resolve(result);
    };
    const timer = setTimeout(() => finish(new TimeoutError('SSH discovery timed out', { command })), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) finish(new DshRemoteError('SSH discovery stdout exceeded limit', { code: 'SSH_DISCOVERY_OUTPUT_TOO_LARGE' }));
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      if (Buffer.byteLength(stderr) > maxOutputBytes) finish(new DshRemoteError('SSH discovery stderr exceeded limit', { code: 'SSH_DISCOVERY_OUTPUT_TOO_LARGE' }));
    });
    child.on('error', (error) => finish(new TransportError('SSH discovery process failed to start', { message: error.message, command })));
    child.on('exit', (code, signal) => code === 0 || allowNonZero
      ? finish(null, { code, signal, stdout, stderr })
      : finish(new TransportError('SSH discovery command failed', { code, signal, command, stderr })));
  });
}

function validateTarget(value) {
  if (typeof value !== 'string' || value.length === 0 || value.startsWith('-') || !SAFE_TARGET.test(value)) {
    throw new DshRemoteError('SSH target is unsafe or invalid', { code: 'SSH_TARGET_INVALID' });
  }
  return value;
}

export function fingerprintSshKey(data) {
  if (typeof data !== 'string' || !/^[A-Za-z0-9+/=]+$/u.test(data)) throw new DshRemoteError('SSH public key encoding is invalid', { code: 'SSH_HOST_KEY_INVALID' });
  return `SHA256:${createHash('sha256').update(Buffer.from(data, 'base64')).digest('base64').replace(/=+$/u, '')}`;
}

export async function resolveSshTarget(sshTarget, { sshPath = 'ssh', spawnImpl = spawn, timeoutMs = 10_000 } = {}) {
  validateTarget(sshTarget);
  const result = await boundedProcess(sshPath, ['-G', sshTarget], { spawnImpl, timeoutMs });
  const values = new Map();
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = line.match(/^([^\s]+)\s+(.+)$/u);
    if (match && !values.has(match[1].toLowerCase())) values.set(match[1].toLowerCase(), match[2].trim());
  }
  const hostname = values.get('hostname');
  const user = values.get('user');
  const port = Number(values.get('port') ?? 22);
  const configuredAlias = values.get('hostkeyalias');
  if (!SAFE_HOSTNAME.test(hostname ?? '') || typeof user !== 'string' || user.length === 0 || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new DshRemoteError('OpenSSH configuration did not resolve a usable target', { code: 'SSH_TARGET_RESOLUTION_INVALID' });
  }
  return { sshTarget, hostname, user, port, configuredHostKeyAlias: configuredAlias && SAFE_HOSTNAME.test(configuredAlias) ? configuredAlias : null };
}

function keyCandidates(source) {
  const candidates = [];
  const seen = new Set();
  for (const line of String(source).split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('@')) continue;
    const parts = trimmed.split(/\s+/u);
    if (parts.length < 3 || !KEY_TYPES.has(parts[1]) || !/^[A-Za-z0-9+/=]+$/u.test(parts[2])) continue;
    const key = `${parts[1]}:${parts[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ keyType: parts[1], publicKey: parts[2], fingerprint: fingerprintSshKey(parts[2]) });
  }
  return candidates;
}

async function probeViaEphemeralKnownHosts(sshTarget, { sshPath, spawnImpl, timeoutMs }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-ssh-probe-'));
  const knownHostsFile = path.join(root, 'known_hosts');
  try {
    const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
    await boundedProcess(sshPath, [
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', `UserKnownHostsFile=${knownHostsFile}`,
      '-o', `GlobalKnownHostsFile=${nullFile}`,
      '-o', 'HashKnownHosts=no',
      '-o', `ConnectTimeout=${Math.max(1, Math.floor(timeoutMs / 2000))}`,
      sshTarget,
      'exit 0',
    ], { spawnImpl, timeoutMs, allowNonZero: true });
    return keyCandidates(await readFile(knownHostsFile, 'utf8').catch(() => ''));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export async function probeSshHostKeys(sshTarget, { sshPath = 'ssh', sshKeyscanPath = 'ssh-keyscan', spawnImpl = spawn, timeoutMs = 20_000 } = {}) {
  const resolved = await resolveSshTarget(sshTarget, { sshPath, spawnImpl, timeoutMs });
  const scan = await boundedProcess(sshKeyscanPath, ['-T', String(Math.max(1, Math.floor(timeoutMs / 3000))), '-p', String(resolved.port), '-t', 'ed25519,ecdsa,rsa', resolved.hostname], { spawnImpl, timeoutMs: Math.max(5_000, Math.floor(timeoutMs / 2)), allowNonZero: true }).catch(() => ({ stdout: '' }));
  let candidates = keyCandidates(scan.stdout);
  if (candidates.length === 0) candidates = await probeViaEphemeralKnownHosts(sshTarget, { sshPath, spawnImpl, timeoutMs });
  if (candidates.length === 0) throw new DshRemoteError('SSH host key probe returned no supported keys', { code: 'SSH_HOST_KEY_PROBE_EMPTY', details: { hostname: resolved.hostname, port: resolved.port } });
  candidates.sort((left, right) => ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'].indexOf(left.keyType) - ['ssh-ed25519', 'ecdsa-sha2-nistp256', 'ssh-rsa'].indexOf(right.keyType));
  return { status: 'needs-confirmation', resolved, candidates };
}

export function selectHostKey(probe, expectedFingerprint) {
  if (!FINGERPRINT.test(expectedFingerprint ?? '')) throw new DshRemoteError('a confirmed OpenSSH SHA-256 fingerprint is required', { code: 'SSH_HOST_KEY_CONFIRMATION_REQUIRED', details: { candidates: probe?.candidates ?? [] } });
  const matches = (probe?.candidates ?? []).filter((candidate) => candidate.fingerprint === expectedFingerprint);
  if (matches.length !== 1) throw new DshRemoteError('confirmed fingerprint does not match exactly one probed host key', { code: 'SSH_HOST_KEY_MISMATCH', details: { expectedFingerprint, candidates: probe?.candidates ?? [] } });
  return matches[0];
}

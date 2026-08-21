import { isAbsolute, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { DshRemoteError } from './errors.mjs';

export function validateSshHostKeyPolicy(policy = {}) {
  if (!policy.knownHostsFile || !isAbsolute(policy.knownHostsFile)) {
    throw new DshRemoteError('SSH requires an absolute known_hosts file; host-key acceptance is never automatic', { code: 'SSH_HOST_KEY_POLICY_REQUIRED' });
  }
  if (!policy.hostKeyAlias || /[\r\n]/.test(policy.hostKeyAlias)) throw new DshRemoteError('SSH hostKeyAlias is required', { code: 'SSH_HOST_KEY_POLICY_REQUIRED' });
  if (!policy.expectedFingerprint && !policy.expectedPublicKey) throw new DshRemoteError('SSH requires a pinned host-key fingerprint or public key', { code: 'SSH_HOST_KEY_PIN_REQUIRED' });
  if (policy.expectedFingerprint && !/^SHA256:[A-Za-z0-9+/=]+$/.test(policy.expectedFingerprint)) throw new DshRemoteError('SSH host-key fingerprint must be an OpenSSH SHA256 fingerprint', { code: 'SSH_HOST_KEY_PIN_INVALID' });
  return {
    knownHostsFile: resolve(policy.knownHostsFile),
    hostKeyAlias: policy.hostKeyAlias,
    expectedFingerprint: policy.expectedFingerprint ?? null,
    expectedPublicKey: policy.expectedPublicKey ?? null,
  };
}

export function buildStrictSshArgs({ policy, host, remoteCommand = [], extraArgs = [] } = {}) {
  const pin = validateSshHostKeyPolicy(policy);
  if (!host || /[\r\n]/.test(host)) throw new DshRemoteError('SSH host is required', { code: 'SSH_HOST_INVALID' });
  if (!Array.isArray(remoteCommand) || remoteCommand.some((value) => typeof value !== 'string')) throw new DshRemoteError('SSH remote command must be argv', { code: 'SSH_COMMAND_INVALID' });
  return [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', `UserKnownHostsFile=${pin.knownHostsFile}`,
    '-o', `HostKeyAlias=${pin.hostKeyAlias}`,
    ...extraArgs,
    host,
    ...remoteCommand,
  ];
}

export function buildStdioBridgeArgs({ policy, host, command = 'dsh-remote-host', dataDir = '~/.dsh-remote/host', extraArgs = [] } = {}) {
  return buildStrictSshArgs({ policy, host, remoteCommand: [command, 'bridge', '--stdio', '--data-dir', dataDir], extraArgs });
}

export function buildReverseTunnelArgs({ policy, host, localPort, remotePort, bindAddress = '127.0.0.1', gatewayHost = '127.0.0.1', extraArgs = [] } = {}) {
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535 || !Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new DshRemoteError('reverse tunnel ports must be valid TCP ports', { code: 'SSH_TUNNEL_PORT_INVALID' });
  }
  if (bindAddress !== '127.0.0.1' || gatewayHost !== '127.0.0.1') throw new DshRemoteError('reverse tunnel must bind loopback on both sides', { code: 'SSH_TUNNEL_BIND_INVALID' });
  return buildStrictSshArgs({ policy, host, extraArgs: ['-N', '-T', '-o', 'ExitOnForwardFailure=yes', '-R', `${bindAddress}:${remotePort}:${gatewayHost}:${localPort}`, ...extraArgs] });
}

export class SshStdioBridge {
  constructor({ sshPath = 'ssh', policy, host, command, dataDir, spawnImpl = spawn } = {}) {
    this.sshPath = sshPath;
    this.policy = policy;
    this.host = host;
    this.command = command;
    this.dataDir = dataDir;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.pending = new Map();
    this.buffer = '';
    this.nextRequestId = 1;
  }

  async start() {
    if (this.child) return;
    const args = buildStdioBridgeArgs({ policy: this.policy, host: this.host, command: this.command, dataDir: this.dataDir });
    this.child = this.spawnImpl(this.sshPath, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.#onData(chunk));
    this.child.on('error', (error) => this.#failPending(error));
    this.child.on('exit', (code, signal) => this.#failPending(new DshRemoteError('SSH stdio bridge exited', { code: 'SSH_BRIDGE_EXITED', details: { code, signal } })));
  }

  async request(message) {
    await this.start();
    const id = String(this.nextRequestId++);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdin.write(`${JSON.stringify({ id, message })}\n`);
    });
  }

  close() {
    this.child?.kill();
    this.child = null;
    this.#failPending(new DshRemoteError('SSH bridge closed', { code: 'SSH_BRIDGE_CLOSED' }));
  }

  #onData(chunk) {
    this.buffer += chunk;
    while (true) {
      const index = this.buffer.indexOf('\n');
      if (index < 0) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch { this.#failPending(new DshRemoteError('SSH bridge returned invalid JSON', { code: 'SSH_BRIDGE_PROTOCOL_ERROR' })); return; }
      const pending = this.pending.get(String(frame.id));
      if (!pending) continue;
      this.pending.delete(String(frame.id));
      if (frame.error) pending.reject(new DshRemoteError(frame.error.message ?? 'remote bridge error', frame.error));
      else pending.resolve(frame.response);
    }
  }

  #failPending(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }
}

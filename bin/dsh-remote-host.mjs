#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { UnixSocketSessionControlPort } from '../lib/session-control-port.mjs';
import { MAX_FRAME_BYTES } from '../lib/protocol.mjs';

const MAX_PENDING_FRAMES = 64;

function argsToObject(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    result[key] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return result;
}

async function loadSessionControl(modulePath, socketPath, hostId) {
  if (socketPath) return new UnixSocketSessionControlPort({ socketPath, hostId });
  if (!modulePath) throw new Error('dsh-remote-host requires --session-control-socket or --session-control-module; refusing to start without the official Session Control port');
  const imported = await import(pathToFileURL(modulePath).href);
  const factory = imported.createSessionControlPort ?? imported.default;
  if (typeof factory === 'function') return await factory();
  if (factory?.openProject) return factory;
  throw new Error('session-control module must export createSessionControlPort() or a default port');
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('dsh-remote-host Stage A only supports Linux x86_64');
  }
  const options = argsToObject(process.argv.slice(2));
  if (options.probe === true) {
    process.stdout.write(`${JSON.stringify({ status: 'ok', component: 'dsh-remote-host', platform: process.platform, arch: process.arch })}\n`);
    return;
  }
  const dataDir = options['data-dir'] || `${homedir()}/.dsh-remote/state`;
  const sessionControl = await loadSessionControl(options['session-control-module'], options['session-control-socket'], options['host-id'] || 'remote-host');
  const daemon = await RemoteHostDaemon.create({ dataDir, sessionControl, allowedRoot: options['allowed-root'] || null, hostId: options['host-id'] || undefined });
  process.on('SIGTERM', () => void daemon.close().then(() => process.exit(0)));
  process.on('SIGINT', () => void daemon.close().then(() => process.exit(0)));
  if (options.bridge === true || options.stdio === true) return runBridge(daemon);
  throw new Error('use: dsh-remote-host bridge --stdio --data-dir <path>');
}

async function runBridge(daemon) {
  let buffer = '';
  let processing = false;
  const seenIds = new Set();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    const bufferedBytes = Buffer.byteLength(buffer, 'utf8');
    if ((!buffer.includes('\n') && bufferedBytes > MAX_FRAME_BYTES) || bufferedBytes > MAX_FRAME_BYTES * MAX_PENDING_FRAMES) return rejectOversized();
    void consume();
  });
  process.stdin.on('end', () => process.exitCode = 0);

  async function consume() {
    if (processing) return;
    processing = true;
    while (true) {
      const index = buffer.indexOf('\n');
      if (index < 0) { processing = false; return; }
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) {
        process.stdout.write(`${JSON.stringify({ id: null, error: { code: 'BRIDGE_FRAME_TOO_LARGE', message: 'frame exceeds maximum size' } })}\n`);
        continue;
      }
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch (error) {
        process.stdout.write(`${JSON.stringify({ id: null, error: { code: 'BRIDGE_INVALID_JSON', message: error.message } })}\n`);
        continue;
      }
      const id = frame.id ?? null;
      if (typeof id !== 'string' || id.length === 0 || id.length > 128) {
        process.stdout.write(`${JSON.stringify({ id, error: { code: 'BRIDGE_FRAME_ID_INVALID', message: 'frame id is required' } })}\n`);
        continue;
      }
      if (seenIds.has(id)) {
        process.stdout.write(`${JSON.stringify({ id, error: { code: 'BRIDGE_DUPLICATE_FRAME', message: 'frame id was already received' } })}\n`);
        continue;
      }
      seenIds.add(id);
      if (seenIds.size > 256) seenIds.delete(seenIds.values().next().value);
      const message = frame.message ?? frame;
      try {
        const response = await daemon.handle(message);
        process.stdout.write(`${JSON.stringify({ id, response })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ id, error: { code: error.code ?? 'BRIDGE_ERROR', message: error.message } })}\n`);
      }
    }
  }

  function rejectOversized() {
    process.stdout.write(`${JSON.stringify({ id: null, error: { code: 'BRIDGE_FRAME_TOO_LARGE', message: 'frame exceeds maximum size' } })}\n`);
    buffer = '';
    process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

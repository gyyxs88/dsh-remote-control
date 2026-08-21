#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { RemoteHostDaemon } from '../lib/remote-host.mjs';
import { SessionControlPort } from '../lib/session-control-port.mjs';

function argsToObject(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    result[key] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? true : argv[++i];
  }
  return result;
}

async function loadSessionControl(modulePath) {
  if (!modulePath) return new SessionControlPort();
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
  const dataDir = options['data-dir'] || `${homedir()}/.dsh-remote/state`;
  const sessionControl = await loadSessionControl(options['session-control-module']);
  const daemon = await RemoteHostDaemon.create({ dataDir, sessionControl, allowedRoot: options['allowed-root'] || null });
  if (options.bridge === true || options.stdio === true) return runBridge(daemon);
  throw new Error('use: dsh-remote-host bridge --stdio --data-dir <path>');
}

async function runBridge(daemon) {
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    void consume();
  });
  process.stdin.on('end', () => process.exitCode = 0);

  async function consume() {
    while (true) {
      const index = buffer.indexOf('\n');
      if (index < 0) return;
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try { frame = JSON.parse(line); } catch (error) {
        process.stdout.write(`${JSON.stringify({ id: null, error: { code: 'BRIDGE_INVALID_JSON', message: error.message } })}\n`);
        continue;
      }
      const id = frame.id ?? null;
      const message = frame.message ?? frame;
      try {
        const response = await daemon.handle(message);
        process.stdout.write(`${JSON.stringify({ id, response })}\n`);
      } catch (error) {
        process.stdout.write(`${JSON.stringify({ id, error: { code: error.code ?? 'BRIDGE_ERROR', message: error.message } })}\n`);
      }
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

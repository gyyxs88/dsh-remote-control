import { chmod, lstat, mkdir, open, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { DshRemoteError } from './errors.mjs';
import { validateRuntimeRequirement } from './desired-state.mjs';

const MAX_FRAME_BYTES = 128 * 1024;
const MAX_PENDING_FRAMES = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

function validateSocketPath(value) {
  if (typeof value !== 'string' || !path.posix.isAbsolute(value) || value.includes('..') || /[\0\r\n]/u.test(value)) throw new DshRemoteError('runtime manager socket path is invalid', { code: 'RUNTIME_MANAGER_SOCKET_INVALID' });
  return value;
}

function validateIdentity(value, label) {
  if (typeof value !== 'string' || !ID.test(value)) throw new DshRemoteError(`${label} is invalid`, { code: 'RUNTIME_MANAGER_IDENTITY_INVALID' });
  return value;
}

function hashToken(value) { return createHash('sha256').update(value, 'utf8').digest('hex'); }

async function loadOrCreateToken(filePath) {
  if (typeof filePath !== 'string' || !path.posix.isAbsolute(filePath) || filePath.includes('..') || /[\0\r\n]/u.test(filePath)) throw new DshRemoteError('runtime manager capability token file is invalid', { code: 'RUNTIME_MANAGER_TOKEN_FILE_INVALID' });
  const validateFile = async () => {
    const parentInfo = await lstat(path.dirname(filePath));
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())) throw new DshRemoteError('runtime manager capability token parent must be an owner-only directory', { code: 'RUNTIME_MANAGER_TOKEN_PARENT_PERMISSIONS' });
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink()) throw new DshRemoteError('runtime manager capability token file must be a regular non-symlink file', { code: 'RUNTIME_MANAGER_TOKEN_FILE_TYPE' });
    if ((info.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && info.uid !== process.getuid())) throw new DshRemoteError('runtime manager capability token file must be owner-only', { code: 'RUNTIME_MANAGER_TOKEN_FILE_PERMISSIONS' });
    const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    let token;
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || (opened.mode & 0o077) !== 0 || (typeof process.getuid === 'function' && opened.uid !== process.getuid()) || opened.ino !== info.ino || opened.dev !== info.dev) throw new DshRemoteError('runtime manager capability token changed while opening', { code: 'RUNTIME_MANAGER_TOKEN_RACE' });
      token = (await handle.readFile({ encoding: 'utf8' })).trim();
      const after = await handle.stat();
      if (after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || (after.mode & 0o077) !== 0) throw new DshRemoteError('runtime manager capability token changed while reading', { code: 'RUNTIME_MANAGER_TOKEN_RACE' });
    } finally { await handle.close(); }
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(token)) throw new DshRemoteError('runtime manager capability token file is invalid', { code: 'RUNTIME_MANAGER_TOKEN_INVALID' });
    return token;
  };
  try {
    return await validateFile();
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const token = randomBytes(32).toString('base64url');
    const parent = path.dirname(filePath);
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o022) !== 0 || (typeof process.getuid === 'function' && parentInfo.uid !== process.getuid())) throw new DshRemoteError('runtime manager capability token parent must be an owner-only directory', { code: 'RUNTIME_MANAGER_TOKEN_PARENT_PERMISSIONS' });
    try { await writeFile(filePath, `${token}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' }); return await validateFile(); }
    catch (race) { if (race?.code !== 'EEXIST') throw race; return await validateFile(); }
  }
}

export class RuntimeManagerService {
  constructor({ daemon, hostId, capabilityToken, logger = console } = {}) {
    if (!daemon || typeof daemon.resolveRuntimeExecutable !== 'function' || typeof daemon.runtimeManager?.inspect !== 'function') throw new DshRemoteError('runtime manager service requires a Remote Host daemon', { code: 'RUNTIME_MANAGER_SERVICE_INVALID' });
    this.daemon = daemon;
    this.hostId = validateIdentity(hostId, 'runtime manager hostId');
    if (typeof capabilityToken !== 'string' || !/^[A-Za-z0-9_-]{32,256}$/u.test(capabilityToken)) throw new DshRemoteError('runtime manager capability token is invalid', { code: 'RUNTIME_MANAGER_TOKEN_INVALID' });
    this.capabilityTokenHash = hashToken(capabilityToken);
    this.logger = logger;
  }

  #assertFrame(frame) {
    if (frame.hostId !== this.hostId || frame.targetHostId !== this.hostId || typeof frame.capabilityToken !== 'string') throw new DshRemoteError('runtime manager request is not bound to the configured Host', { code: 'RUNTIME_MANAGER_IDENTITY_MISMATCH' });
    const expected = Buffer.from(this.capabilityTokenHash, 'utf8');
    const actual = Buffer.from(hashToken(frame.capabilityToken), 'utf8');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new DshRemoteError('runtime manager capability token is invalid', { code: 'RUNTIME_MANAGER_CAPABILITY_INVALID' });
  }

  async handle(frame = {}) {
    this.#assertFrame(frame);
    const message = frame.message ?? frame;
    if (message.type === 'runtime-manager.ping') return { type: 'runtime-manager.pong', hostId: this.hostId };
    if (message.type === 'runtime-manager.inspect') {
      if (!Array.isArray(message.requirements)) throw new DshRemoteError('runtime manager inspect requirements must be an array', { code: 'RUNTIME_REQUIREMENTS_INVALID' });
      return { type: 'runtime-manager.inspect.result', hostId: this.hostId, states: await this.daemon.runtimeManager.inspect(message.requirements.map(validateRuntimeRequirement)) };
    }
    if (message.type === 'runtime-manager.resolve') {
      const sourceHostId = validateIdentity(frame.sourceHostId, 'runtime manager sourceHostId');
      const sourceSessionId = validateIdentity(frame.sourceSessionId, 'runtime manager sourceSessionId');
      const targetSessionId = validateIdentity(message.targetSessionId, 'runtime manager targetSessionId');
      const result = await this.daemon.resolveRuntimeExecutable(validateRuntimeRequirement(message.requirement), { sourceHostId, sourceSessionId, targetHostId: this.hostId, targetSessionId });
      if (!result || typeof result.executable !== 'string' || (!path.posix.isAbsolute(result.executable) && !path.win32.isAbsolute(result.executable))) throw new DshRemoteError('runtime manager returned no absolute executable', { code: 'RUNTIME_EXECUTABLE_INVALID' });
      return { type: 'runtime-manager.resolve.result', hostId: this.hostId, targetSessionId, result };
    }
    throw new DshRemoteError('unsupported runtime manager request', { code: 'RUNTIME_MANAGER_METHOD_UNSUPPORTED' });
  }
}

export async function startRuntimeManagerService({ daemon, socketPath, hostId, capabilityToken, capabilityTokenFile, logger = console } = {}) {
  const safeSocketPath = validateSocketPath(socketPath);
  const token = capabilityToken ?? (capabilityTokenFile ? await loadOrCreateToken(capabilityTokenFile) : null);
  const service = new RuntimeManagerService({ daemon, hostId, capabilityToken: token, logger });
  try {
    const info = await lstat(safeSocketPath);
    if (info.isSocket()) await unlink(safeSocketPath);
    else throw new DshRemoteError('runtime manager socket path is occupied by a non-socket', { code: 'RUNTIME_MANAGER_SOCKET_OCCUPIED' });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const server = net.createServer((socket) => {
    let buffer = '';
    let pending = 0;
    let processing = Promise.resolve();
    const seenIds = new Set();
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n') && Buffer.byteLength(buffer, 'utf8') > MAX_FRAME_BYTES) return socket.destroy();
      while (true) {
        const index = buffer.indexOf('\n');
        if (index < 0) break;
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (Buffer.byteLength(line, 'utf8') > MAX_FRAME_BYTES) return socket.destroy();
        if (!line.trim()) continue;
        if (pending >= MAX_PENDING_FRAMES) { socket.write(`${JSON.stringify({ id: null, error: { code: 'RUNTIME_MANAGER_PENDING_LIMIT', message: 'too many queued runtime manager requests' } })}\n`); continue; }
        let frame;
        try { frame = JSON.parse(line); } catch (error) { socket.write(`${JSON.stringify({ id: null, error: { code: 'RUNTIME_MANAGER_INVALID_JSON', message: error.message } })}\n`); continue; }
        const id = frame.id ?? null;
        if (typeof id !== 'string' || id.length === 0 || id.length > 128) { socket.write(`${JSON.stringify({ id, error: { code: 'RUNTIME_MANAGER_FRAME_ID_INVALID', message: 'frame id is required' } })}\n`); continue; }
        if (seenIds.has(id)) { socket.write(`${JSON.stringify({ id, error: { code: 'RUNTIME_MANAGER_DUPLICATE_FRAME', message: 'frame id was already received' } })}\n`); continue; }
        seenIds.add(id);
        if (seenIds.size > 256) seenIds.delete(seenIds.values().next().value);
        pending += 1;
        processing = processing.then(async () => {
          try { socket.write(`${JSON.stringify({ id, response: await service.handle(frame) })}\n`); }
          catch (error) { socket.write(`${JSON.stringify({ id, error: { code: error.code ?? 'RUNTIME_MANAGER_ERROR', message: String(error.message ?? error) } })}\n`); }
        }).catch((error) => logger.warn?.(`runtime manager service frame failed: ${String(error)}`)).finally(() => { pending -= 1; });
      }
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(safeSocketPath, () => { server.off('error', reject); resolve(); }); });
  await chmod(safeSocketPath, 0o600);
  return { socketPath: safeSocketPath, service, async close() { await new Promise((resolve) => server.close(() => resolve())); await unlink(safeSocketPath).catch(() => {}); } };
}

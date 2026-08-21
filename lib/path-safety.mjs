import { lstat, realpath } from 'node:fs/promises';
import { posix } from 'node:path';
import { ProtocolError } from './errors.mjs';

export function isWithinAllowedRoot(root, candidate) {
  const relative = posix.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !posix.isAbsolute(relative));
}

export async function canonicalizeExistingOrAncestor(candidate) {
  let current = candidate;
  const suffix = [];
  while (true) {
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) current = await realpath(current);
      else current = await realpath(current);
      return posix.normalize(posix.join(current, ...suffix.reverse()));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const parent = posix.dirname(current);
      if (parent === current) throw new ProtocolError('path has no canonical existing ancestor', { candidate });
      suffix.push(posix.basename(current));
      current = parent;
    }
  }
}

export async function assertWithinAllowedRoot(candidate, allowedRoot) {
  if (!allowedRoot) return candidate;
  const root = await canonicalizeExistingOrAncestor(allowedRoot);
  const resolved = await canonicalizeExistingOrAncestor(candidate);
  if (!isWithinAllowedRoot(root, resolved)) throw new ProtocolError('project path escapes allowed root', { candidate, allowedRoot: root, resolved });
  return resolved;
}

export function validateSafePosixPath(value, { allowHome = true, field = 'path' } = {}) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || /[\r\n]/.test(value) || value.split('/').includes('..')) throw new ProtocolError(`${field} is unsafe`);
  if (!(value.startsWith('/') || (allowHome && value.startsWith('~/')))) throw new ProtocolError(`${field} must be absolute or home-relative`);
  return value;
}

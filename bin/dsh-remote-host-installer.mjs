#!/usr/bin/env node
import { mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

async function main() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('installer only supports Linux x86_64');
  const artifact = option('artifact');
  const expectedSha = option('sha256');
  const version = option('version');
  const protocolVersion = option('protocol-version');
  const installRoot = option('install-root');
  if (!artifact || !expectedSha || !version || !protocolVersion || !installRoot || !process.argv.includes('--atomic') || !process.argv.includes('--no-root')) throw new Error('installer requires a verified atomic no-root install plan');
  const actualSha = createHash('sha256').update(await readFile(artifact)).digest('hex');
  if (actualSha !== expectedSha) throw new Error('artifact SHA-256 mismatch');
  const sourceStat = await stat(artifact);
  const versionsRoot = join(installRoot, 'versions');
  const versionRoot = join(versionsRoot, version);
  const tempRoot = join(installRoot, `.staging-${version}-${process.pid}-${randomUUID()}`);
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(tempRoot, 'artifact'), await readFile(artifact), { mode: 0o700 });
  await writeFile(join(tempRoot, 'manifest.json'), `${JSON.stringify({ version, protocolVersion, sha256: actualSha, size: sourceStat.size }, null, 2)}\n`, { mode: 0o600 });
  await mkdir(versionsRoot, { recursive: true, mode: 0o700 });
  try {
    const existingManifest = JSON.parse(await readFile(join(versionRoot, 'manifest.json'), 'utf8'));
    if (existingManifest.sha256 !== actualSha) throw new Error('same runtime version is already installed with a different digest');
    await rm(tempRoot, { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    await rename(tempRoot, versionRoot);
  }
  const currentLink = join(installRoot, 'current');
  const nextLink = join(installRoot, `.current-${process.pid}-${randomUUID()}`);
  await symlink(`versions/${version}`, nextLink, 'dir');
  await rename(nextLink, currentLink);
  process.stdout.write(`${JSON.stringify({ status: 'installed', version, protocolVersion, installRoot })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

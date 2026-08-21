#!/usr/bin/env node
import { installRemoteArtifact, inspectRemoteArtifact, rollbackRemoteArtifact } from '../lib/remote-artifact-installer.mjs';
import { validateSafePosixPath } from '../lib/path-safety.mjs';

function option(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

function required(name) {
  const value = option(name);
  if (!value || value.startsWith('--')) throw new Error(`--${name} is required`);
  return value;
}

function assertNonRootRuntime() {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('remote artifact installer only supports Linux x86_64');
  if (typeof process.getuid === 'function' && process.getuid() === 0) throw new Error('remote artifact installer refuses to run as root');
}

async function main() {
  assertNonRootRuntime();
  const kind = required('kind');
  const id = required('id');
  const installRoot = required('install-root');
  validateSafePosixPath(installRoot, { field: 'plugin install root', allowHome: false });
  if (process.argv.includes('--status') || process.argv.includes('--probe')) {
    process.stdout.write(`${JSON.stringify(await inspectRemoteArtifact({ kind, id, installRoot }))}\n`);
    return;
  }
  if (!process.argv.includes('--atomic') || !process.argv.includes('--no-scripts')) throw new Error('remote artifact installer requires --atomic and --no-scripts');
  if (process.argv.includes('--rollback')) {
    const target = process.argv.includes('--target-missing')
      ? { status: 'missing' }
      : {
        status: 'installed',
        version: required('target-version'),
        sha256: required('target-sha256'),
        size: Number(required('target-size')),
        packageName: required('target-package-name'),
        target: option('target') ?? 'linux-x86_64',
        protocolVersion: option('protocol-version') ?? '1.0',
        ...(kind === 'runtime' ? { executablePath: required('target-executable-path') } : {}),
      };
    process.stdout.write(`${JSON.stringify(await rollbackRemoteArtifact({ kind, id, installRoot, target }))}\n`);
    return;
  }
  const result = await installRemoteArtifact({
    artifactPath: required('artifact'),
    kind,
    id,
    version: required('version'),
    expectedSha256: required('sha256'),
    installRoot,
    packageName: required('package-name'),
    ...(kind === 'runtime' ? { executablePath: required('executable-path') } : {}),
    protocolVersion: option('protocol-version') ?? '1.0',
    target: option('target') ?? 'linux-x86_64',
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});

import { posix } from 'node:path';
import { DshRemoteError } from './errors.mjs';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const PROTOCOL = /^\d+\.\d+$/u;

export function validateInstallerInputs({ platform = process.platform, arch = process.arch, uid = typeof process.getuid === 'function' ? process.getuid() : null, version, protocolVersion, installRoot, artifact, expectedSha, atomic = false, noRoot = false } = {}) {
  if (platform !== 'linux' || arch !== 'x64') throw new DshRemoteError('installer only supports Linux x86_64', { code: 'INSTALLER_PLATFORM_UNSUPPORTED' });
  if (uid === 0) throw new DshRemoteError('installer refuses to run as root', { code: 'INSTALLER_ROOT_FORBIDDEN' });
  if (!VERSION.test(version ?? '')) throw new DshRemoteError('version is not a supported semver value', { code: 'INSTALLER_VERSION_INVALID' });
  if (!PROTOCOL.test(protocolVersion ?? '')) throw new DshRemoteError('protocol-version is invalid', { code: 'INSTALLER_PROTOCOL_INVALID' });
  if (typeof installRoot !== 'string' || !posix.isAbsolute(installRoot) || installRoot.split('/').includes('..') || /[\0\r\n]/u.test(installRoot)) throw new DshRemoteError('install-root must be a safe absolute POSIX path', { code: 'INSTALLER_PATH_INVALID' });
  if (typeof artifact !== 'string' || !posix.isAbsolute(artifact) || artifact.split('/').includes('..') || !/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(posix.basename(artifact)) || /[\0\r\n]/u.test(artifact)) throw new DshRemoteError('artifact path is invalid', { code: 'INSTALLER_ARTIFACT_INVALID' });
  if (!/^[a-f0-9]{64}$/u.test(expectedSha ?? '')) throw new DshRemoteError('artifact digest is invalid', { code: 'INSTALLER_DIGEST_INVALID' });
  if (atomic !== true || noRoot !== true) throw new DshRemoteError('installer requires atomic and no-root policy', { code: 'INSTALLER_POLICY_REQUIRED' });
  return { version, protocolVersion, installRoot: posix.normalize(installRoot), artifact, expectedSha };
}

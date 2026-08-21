import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, posix } from 'node:path';
import { DshRemoteError, NeedsAttentionError } from './errors.mjs';

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

export async function createArtifactManifest({ filePath, version, protocolVersion = '1.0', target = 'linux-x86_64', signature = null } = {}) {
  if (!filePath || !version) throw new DshRemoteError('artifact filePath and version are required', { code: 'ARTIFACT_MANIFEST_INVALID' });
  const fileStat = await stat(filePath);
  return { name: basename(filePath), version, protocolVersion, target, size: fileStat.size, sha256: await sha256File(filePath), signature };
}

export async function verifyTrustedArtifact({ filePath, manifest, trustedSha256 } = {}) {
  if (!manifest?.sha256 || !manifest?.version || manifest.target !== 'linux-x86_64') throw new DshRemoteError('artifact manifest is not trusted for Stage A', { code: 'ARTIFACT_MANIFEST_INVALID' });
  if (trustedSha256 && trustedSha256 !== manifest.sha256) throw new DshRemoteError('artifact is not in the trusted digest catalog', { code: 'ARTIFACT_NOT_TRUSTED', details: { version: manifest.version } });
  const actual = await sha256File(filePath);
  if (actual !== manifest.sha256) throw new DshRemoteError('artifact SHA-256 mismatch', { code: 'ARTIFACT_HASH_MISMATCH', details: { expected: manifest.sha256, actual } });
  const fileStat = await stat(filePath);
  if (fileStat.size !== manifest.size) throw new DshRemoteError('artifact size mismatch', { code: 'ARTIFACT_SIZE_MISMATCH' });
  return { ...manifest, verified: true };
}

export function buildBootstrapPlan({ artifact, remoteRoot = '~/.dsh-remote', operationId = randomUUID() } = {}) {
  if (!artifact?.verified || !artifact.sha256 || !artifact.version) throw new DshRemoteError('bootstrap requires a verified artifact', { code: 'BOOTSTRAP_ARTIFACT_REQUIRED' });
  if (!remoteRoot || remoteRoot.includes('..') || !remoteRoot.startsWith('/') && !remoteRoot.startsWith('~/' )) throw new DshRemoteError('remoteRoot must be an absolute or home-relative POSIX path', { code: 'BOOTSTRAP_ROOT_INVALID' });
  const staging = posix.join(remoteRoot, 'staging', operationId);
  const installRoot = posix.join(remoteRoot, 'host');
  return {
    operationId,
    artifact: { name: artifact.name, version: artifact.version, sha256: artifact.sha256, size: artifact.size },
    uploadPath: posix.join(staging, artifact.name),
    installRoot,
    commands: [
      ['mkdir', '-p', staging],
      ['dsh-remote-host-installer', '--artifact', posix.join(staging, artifact.name), '--sha256', artifact.sha256, '--version', artifact.version, '--protocol-version', artifact.protocolVersion ?? '1.0', '--install-root', installRoot, '--atomic', '--no-root'],
      ['rm', '-f', posix.join(staging, artifact.name)],
      ['rmdir', staging],
    ],
    safety: { noShellPipe: true, noCurlPipeSh: true, noRoot: true, atomicSwitch: true, failClosedOnUnknown: true },
  };
}

export class ArtifactBootstrapper {
  constructor({ transport, trustedSha256ByVersion = {} } = {}) {
    if (!transport || typeof transport.upload !== 'function' || typeof transport.execArgv !== 'function') throw new DshRemoteError('bootstrap transport must provide upload and execArgv', { code: 'BOOTSTRAP_TRANSPORT_INVALID' });
    this.transport = transport;
    this.trustedSha256ByVersion = trustedSha256ByVersion;
  }

  async bootstrap({ filePath, version, remoteRoot } = {}) {
    const manifest = await createArtifactManifest({ filePath, version });
    const trustedSha256 = this.trustedSha256ByVersion[version];
    const verified = await verifyTrustedArtifact({ filePath, manifest, trustedSha256 });
    const plan = buildBootstrapPlan({ artifact: verified, remoteRoot });
    try {
      await this.transport.execArgv(plan.commands[0]);
      await this.transport.upload(filePath, plan.uploadPath, { sha256: verified.sha256, size: verified.size });
      await this.transport.execArgv(plan.commands[1]);
      await this.transport.execArgv(plan.commands[2]);
      await this.transport.execArgv(plan.commands[3]);
    } catch (error) {
      if (error?.code === 'TRANSPORT_ERROR' || error?.code === 'SSH_BRIDGE_EXITED') {
        throw new NeedsAttentionError('bootstrap terminal state is unknown; reconcile bootstrap.status before retrying', { operationId: plan.operationId, plan, cause: error.message });
      }
      throw error;
    }
    return { status: 'completed', manifest: verified, plan };
  }
}

import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, stat } from 'node:fs/promises';
import { basename, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DshRemoteError, NeedsAttentionError } from './errors.mjs';
import { validateSafePosixPath } from './path-safety.mjs';

const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/u;
const PROTOCOL = /^\d+\.\d+$/u;

export async function sha256File(filePath) {
  const hash = createHash('sha256');
  hash.update(await readFile(filePath));
  return hash.digest('hex');
}

async function regularFile(filePath) {
  const link = await lstat(filePath);
  if (!link.isFile() || link.isSymbolicLink()) throw new DshRemoteError('artifact must be a regular non-symlink file', { code: 'ARTIFACT_FILE_INVALID' });
  return stat(filePath);
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || typeof manifest.name !== 'string' || !VERSION.test(manifest.version) || !PROTOCOL.test(manifest.protocolVersion) || manifest.target !== 'linux-x86_64' || !Number.isSafeInteger(manifest.size) || manifest.size <= 0 || !/^[a-f0-9]{64}$/u.test(manifest.sha256)) throw new DshRemoteError('artifact manifest fields are invalid', { code: 'ARTIFACT_MANIFEST_INVALID' });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/u.test(manifest.name)) throw new DshRemoteError('artifact name must be a safe npm pack .tgz name', { code: 'ARTIFACT_MANIFEST_INVALID' });
  return manifest;
}

export async function createArtifactManifest({ filePath, version, protocolVersion = '1.0', target = 'linux-x86_64', signature = null } = {}) {
  if (!filePath || !VERSION.test(version ?? '') || !PROTOCOL.test(protocolVersion) || target !== 'linux-x86_64') throw new DshRemoteError('artifact manifest inputs are invalid', { code: 'ARTIFACT_MANIFEST_INVALID' });
  const fileStat = await regularFile(filePath);
  return validateManifest({ name: basename(filePath), version, protocolVersion, target, size: fileStat.size, sha256: await sha256File(filePath), signature });
}

export async function verifyTrustedArtifact({ filePath, manifest, trustedCatalog, version = manifest?.version } = {}) {
  const candidate = validateManifest(manifest);
  const trusted = trustedCatalog?.[version];
  if (!trusted || trusted.version !== version || typeof trusted.name !== 'string' || trusted.name !== candidate.name || typeof trusted.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(trusted.sha256) || !Number.isSafeInteger(trusted.size) || trusted.size <= 0 || trusted.target !== 'linux-x86_64' || trusted.protocolVersion !== candidate.protocolVersion) throw new DshRemoteError('artifact version is absent from the trusted digest catalog', { code: 'ARTIFACT_NOT_TRUSTED', details: { version } });
  if (candidate.version !== version || candidate.sha256 !== trusted.sha256 || candidate.size !== trusted.size) throw new DshRemoteError('artifact manifest does not match the trusted catalog', { code: 'ARTIFACT_NOT_TRUSTED', details: { version } });
  const fileStat = await regularFile(filePath);
  if (fileStat.size !== candidate.size) throw new DshRemoteError('artifact size mismatch', { code: 'ARTIFACT_SIZE_MISMATCH' });
  const actual = await sha256File(filePath);
  if (actual !== candidate.sha256) throw new DshRemoteError('artifact SHA-256 mismatch', { code: 'ARTIFACT_HASH_MISMATCH', details: { expected: candidate.sha256, actual } });
  return { ...candidate, verified: true };
}

export function buildBootstrapPlan({ artifact, installerPath = 'bin/dsh-remote-host-installer.mjs', remoteRoot, operationId = randomUUID() } = {}) {
  if (!artifact?.verified) throw new DshRemoteError('bootstrap requires a verified artifact', { code: 'BOOTSTRAP_ARTIFACT_REQUIRED' });
  validateManifest(artifact);
  if (!/^[a-f0-9]{64}$/u.test(artifact.installerSha256 ?? '')) throw new DshRemoteError('bootstrap requires a trusted installer digest', { code: 'BOOTSTRAP_NOT_TRUSTED' });
  validateSafePosixPath(remoteRoot, { field: 'remoteRoot', allowHome: false });
  if (typeof installerPath !== 'string' || installerPath.length === 0) throw new DshRemoteError('bootstrap installer path is required', { code: 'BOOTSTRAP_INSTALLER_REQUIRED' });
  const safeOperationId = String(operationId);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{7,127}$/u.test(safeOperationId)) throw new DshRemoteError('bootstrap operation id is invalid', { code: 'BOOTSTRAP_OPERATION_INVALID' });
  const staging = posix.join(remoteRoot, 'staging', safeOperationId);
  const installRoot = posix.join(remoteRoot, 'host');
  const remoteArtifactPath = posix.join(staging, artifact.name);
  const remoteInstallerPath = posix.join(staging, 'dsh-remote-host-installer.mjs');
  const remoteHostEntry = posix.join(installRoot, 'current', 'bin', 'dsh-remote-host.mjs');
  const installedInstallerPath = posix.join(installRoot, 'current', 'bin', 'dsh-remote-host-installer.mjs');
  return {
    operationId: safeOperationId,
    artifact: { name: artifact.name, version: artifact.version, protocolVersion: artifact.protocolVersion, target: artifact.target, sha256: artifact.sha256, size: artifact.size },
    installerSha256: artifact.installerSha256,
    installerPath,
    uploadPath: remoteArtifactPath,
    installerUploadPath: remoteInstallerPath,
    remoteInstallerPath,
    remoteHostEntry,
    installedInstallerPath,
    installRoot,
    commands: [
      ['mkdir', '-p', staging],
      ['sha256sum', remoteInstallerPath],
      ['node', remoteInstallerPath, '--artifact', remoteArtifactPath, '--sha256', artifact.sha256, '--version', artifact.version, '--protocol-version', artifact.protocolVersion, '--install-root', installRoot, '--atomic', '--no-root'],
      ['node', remoteHostEntry, '--probe'],
      ['rm', '-f', remoteArtifactPath, remoteInstallerPath],
      ['rmdir', staging],
    ],
    safety: { noPreinstalledPackageRequired: true, noShellPipe: true, noCurlPipeSh: true, noRoot: true, atomicSwitch: true, failClosedOnUnknown: true },
  };
}

export class ArtifactBootstrapper {
  constructor({ transport, trustedCatalog = {}, installerPath = fileURLToPath(new URL('../bin/dsh-remote-host-installer.mjs', import.meta.url)) } = {}) {
    if (!transport || typeof transport.upload !== 'function' || typeof transport.execArgv !== 'function') throw new DshRemoteError('bootstrap transport must provide upload and execArgv', { code: 'BOOTSTRAP_TRANSPORT_INVALID' });
    this.transport = transport;
    this.trustedCatalog = trustedCatalog;
    this.installerPath = installerPath;
    this.statuses = new Map();
  }

  status(operationId) {
    return this.statuses.get(operationId) ?? { status: 'unknown', operationId };
  }

  async bootstrap({ filePath, version, remoteRoot } = {}) {
    const manifest = await createArtifactManifest({ filePath, version });
    const verified = await verifyTrustedArtifact({ filePath, manifest, trustedCatalog: this.trustedCatalog, version });
    await regularFile(this.installerPath);
    const trustedInstallerSha256 = this.trustedCatalog?.[version]?.installerSha256;
    if (!/^[a-f0-9]{64}$/u.test(trustedInstallerSha256 ?? '')) throw new DshRemoteError('bootstrap installer is absent from the trusted digest catalog', { code: 'BOOTSTRAP_NOT_TRUSTED', details: { version } });
    const installerSha256 = await sha256File(this.installerPath);
    if (installerSha256 !== trustedInstallerSha256) throw new DshRemoteError('bootstrap installer does not match the trusted digest catalog', { code: 'BOOTSTRAP_NOT_TRUSTED', details: { version } });
    const plan = buildBootstrapPlan({ artifact: { ...verified, installerSha256 }, installerPath: this.installerPath, remoteRoot });
    this.statuses.set(plan.operationId, { status: 'running', operationId: plan.operationId, plan });
    try {
      await this.transport.execArgv(plan.commands[0]);
      await this.transport.upload(this.installerPath, plan.installerUploadPath, { sha256: await sha256File(this.installerPath) });
      await this.transport.upload(filePath, plan.uploadPath, { sha256: verified.sha256, size: verified.size });
      const remoteInstallerDigest = await this.transport.execArgv(plan.commands[1]);
      if (String(remoteInstallerDigest.stdout ?? '').trim().split(/\s+/u)[0] !== installerSha256) throw new DshRemoteError('remote bootstrap installer digest mismatch', { code: 'BOOTSTRAP_INSTALLER_HASH_MISMATCH' });
      await this.transport.execArgv(plan.commands[2]);
      const probe = await this.transport.execArgv(plan.commands[3]);
      const probeResult = JSON.parse(probe.stdout ?? '{}');
      if (probeResult.status !== 'ok' || probeResult.component !== 'dsh-remote-host' || probeResult.platform !== 'linux' || probeResult.arch !== 'x64') throw new DshRemoteError('installed Remote Host probe failed', { code: 'BOOTSTRAP_PROBE_FAILED' });
      await this.transport.execArgv(plan.commands[4]);
      await this.transport.execArgv(plan.commands[5]);
      const result = { status: 'completed', manifest: verified, plan };
      this.statuses.set(plan.operationId, result);
      return result;
    } catch (error) {
      const attention = new NeedsAttentionError('bootstrap terminal state is unknown; reconcile bootstrap status before retrying', { operationId: plan.operationId, plan, cause: error.message });
      this.statuses.set(plan.operationId, { status: 'needs-attention', operationId: plan.operationId, plan, error: attention.details });
      throw attention;
    }
  }

  async reconcile(plan) {
    const current = this.status(plan.operationId);
    if (current.status !== 'needs-attention') return current;
    try {
      const result = await this.transport.execArgv(['node', plan.installedInstallerPath, '--status', '--install-root', plan.installRoot]);
      const parsed = JSON.parse(result.stdout ?? '{}');
      if (parsed.status === 'installed' && parsed.version === plan.artifact.version && parsed.sha256 === plan.artifact.sha256) {
        const resolved = { ...current, status: 'completed', reconciled: true, remote: parsed };
        this.statuses.set(plan.operationId, resolved);
        return resolved;
      }
      return { ...current, status: 'needs-attention', reconciled: false, remote: parsed };
    } catch (error) {
      return { ...current, status: 'needs-attention', reconciled: false, reconcileError: error.message };
    }
  }
}

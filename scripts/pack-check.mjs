import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const npmCli = process.env.npm_execpath || join(process.env.ProgramFiles || 'C:\\Program Files', 'nodejs', 'node_modules', 'npm', 'bin', 'npm-cli.js');
let gatewayProcess = null;
function runNpm(args) {
  if (process.platform === 'win32' && existsSync(npmCli)) return spawnSync(process.execPath, [npmCli, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (process.platform === 'win32') return spawnSync('npm.cmd', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return spawnSync(npm, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}
const root = await mkdtemp(join(tmpdir(), 'dsh-remote-pack-'));
try {
  const pack = runNpm(['pack', '--pack-destination', root]);
  if (pack.status !== 0) throw new Error(`npm pack failed: ${pack.stderr ?? pack.error?.message ?? 'unknown error'}`);
  const tgz = (await readdir(root)).find((name) => name.endsWith('.tgz'));
  if (!tgz) throw new Error('npm pack produced no tgz');
  const consumer = join(root, 'consumer');
  const install = runNpm(['install', '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund', '--offline', '--prefix', consumer, join(root, tgz)]);
  if (install.status !== 0) throw new Error(`packed tgz install failed: ${install.stderr ?? install.error?.message ?? 'unknown error'}`);
  const packageRoot = join(consumer, 'node_modules', 'dsh-remote-control');
  const packageEntry = pathToFileURL(join(packageRoot, 'lib', 'index.mjs')).href;
  const importCheck = spawnSync(process.execPath, ['-e', `const m=await import(${JSON.stringify(packageEntry)}); if(typeof m.RemoteControlConnector!=='function'||typeof m.RemoteHostDaemon!=='function'||typeof m.ModelGateway!=='function'||typeof m.DesiredStateSynchronizer!=='function'||typeof m.TrustedArtifactRegistry!=='function'||typeof m.InstalledRuntimeManager!=='function'||typeof m.RuntimeSynchronizer!=='function'||typeof m.DshHostBootstrapper!=='function'||typeof m.DshHttpClient!=='function'||typeof m.HostRegistry!=='function'||typeof m.RemoteProjectController!=='function') process.exit(2)`], { encoding: 'utf8', stdio: 'pipe' });
  if (importCheck.status !== 0) throw new Error(`packed import smoke failed: ${importCheck.stderr}`);
  for (const file of ['dsh-remote-host.mjs', 'dsh-remote-host-installer.mjs', 'dsh-remote-dsh-installer.mjs', 'dsh-remote-artifact-installer.mjs', 'dsh-model-gateway.mjs']) {
    const check = spawnSync(process.execPath, ['--check', join(packageRoot, 'bin', file)], { encoding: 'utf8', stdio: 'pipe' });
    if (check.status !== 0) throw new Error(`packed bin smoke failed for ${file}: ${check.stderr}`);
  }
  const pluginCheck = spawnSync(process.execPath, ['--check', join(packageRoot, 'lib', 'dsh-plugin.mjs')], { encoding: 'utf8', stdio: 'pipe' });
  if (pluginCheck.status !== 0) throw new Error(`packed DSH plugin smoke failed: ${pluginCheck.stderr}`);
  const packedPackage = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const skillPath = join(packageRoot, 'skills', 'dsh-remote-project', 'SKILL.md');
  const skillDigest = createHash('sha256').update(await readFile(skillPath)).digest('hex');
  if (packedPackage.dsh?.control?.bundledSkills?.[0]?.sha256 !== skillDigest || packedPackage.dsh?.bundle?.patch !== './cordis.patch.yml') throw new Error('packed DSH plugin/Skill manifest is invalid');
  const gateway = gatewayProcess = spawn(process.execPath, [join(packageRoot, 'bin', 'dsh-model-gateway.mjs'), '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  let gatewayOutput = '';
  gateway.stderr.setEncoding('utf8');
  const gatewayReady = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('packed gateway smoke timed out')), 5_000);
    gateway.stderr.on('data', (chunk) => {
      gatewayOutput += chunk;
      const match = /listening on (http:\/\/127\.0\.0\.1:\d+)/u.exec(gatewayOutput);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    gateway.once('error', (error) => { clearTimeout(timer); reject(error); });
    gateway.once('exit', (code) => { if (code !== null && code !== 0) { clearTimeout(timer); reject(new Error(`packed gateway exited ${code}: ${gatewayOutput}`)); } });
  });
  const endpoint = await gatewayReady;
  const health = await fetch(`${endpoint}/health`);
  if (!health.ok || (await health.json()).status !== 'ok') throw new Error('packed gateway health smoke failed');
  gateway.kill();
  await once(gateway, 'exit');
  gatewayProcess = null;
  console.log(JSON.stringify({ status: 'passed', tarball: tgz, imported: true, binsChecked: 5, pluginChecked: true, skillDigest }));
} finally {
  if (gatewayProcess && !gatewayProcess.killed) gatewayProcess.kill();
  await rm(root, { recursive: true, force: true });
}

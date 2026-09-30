// Explicit isolated development runner. It never edits an installed DSH profile.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('Use Node 24');
const args = process.argv.slice(2);
const suite = args[0] === '--suite' ? args[1] : 'all';
const sdk = args.includes('--web-rc1') ? 'rc1' : 'rc2';
if (!['all', 'plugin', 'pack'].includes(suite)) throw new Error('Unknown suite');
const runs = path.join(repo, 'temp/official-test-runtime');
fs.mkdirSync(runs, { recursive: true });
const run = fs.mkdtempSync(path.join(runs, `${sdk}-${suite}-`));
const fixture = path.join(run, 'fixtures');
fs.mkdirSync(fixture);
const nodeDir = path.dirname(process.execPath);
const npmCli = path.join(nodeDir, 'node_modules/npm/bin/npm-cli.js');
const env = { TMP: fixture, TEMP: fixture, TMPDIR: fixture, REMOTE_TEST_TMP: fixture, REMOTE_TEST_SDK: sdk,
  npm_execpath: npmCli, npm_config_cache: path.join(run, 'npm-cache'), npm_config_offline: 'true',
  SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', PATH: `${nodeDir};C:\\Windows\\System32`, PATHEXT: '.COM;.EXE;.BAT;.CMD' };
const preloader = pathToFileURL(path.join(repo, 'scripts/official-test-runtime.mjs')).href;
let command;
let tarball;
if (suite === 'pack') {
  const meta = JSON.parse(fs.readFileSync(path.join(repo, 'package.json')));
  const artifacts = path.join(repo, 'dist');
  fs.mkdirSync(artifacts, { recursive: true });
  const stage = path.join(fixture, 'stage');
  fs.mkdirSync(stage);
  for (const file of meta.files) fs.cpSync(path.join(repo, file), path.join(stage, file), { recursive: true });
  if (sdk === 'rc1') {
    meta.version = '0.3.3-compat020rc1.1';
    meta.dsh.control.version = meta.version;
    meta.peerDependencies['@deepseek-ai/dsh-tools'] = '0.2.0-rc.1';
    meta.peerDependencies['@deepseek-ai/schemastery'] = '~3.18.4';
    meta.dsh.control.dshCompatibility = { min: '0.2.0-rc.1', max: '0.2.0-rc.1' };
  }
  fs.writeFileSync(path.join(stage, 'package.json'), JSON.stringify(meta, null, 2) + '\n');
  tarball = path.join(artifacts, `${meta.name}-${meta.version}.tgz`);
  if (fs.existsSync(tarball)) throw new Error('Refusing to overwrite existing tarball: ' + tarball);
  const pack = spawnSync(process.execPath, [npmCli, 'pack', '--ignore-scripts', '--pack-destination', artifacts], { cwd: stage, env, encoding: 'utf8', windowsHide: true });
  fs.writeFileSync(path.join(run, 'npm-pack.log'), (pack.stdout ?? '') + (pack.stderr ?? ''));
  if (pack.status !== 0) throw new Error('npm pack failed: ' + pack.stderr);
  env.REMOTE_PACK_TARBALL = tarball;
  command = ['--import', preloader, 'scripts/pack-check.mjs'];
} else {
  const tests = suite === 'plugin' ? ['test/dsh-plugin.test.mjs'] : fs.readdirSync(path.join(repo, 'test')).filter(f => f.endsWith('.test.mjs')).sort().map(f => 'test/' + f);
  command = ['--import', preloader, '--test', '--experimental-test-isolation=none', ...tests];
}
const result = spawnSync(process.execPath, command, { cwd: repo, env, encoding: 'utf8', windowsHide: true });
fs.writeFileSync(path.join(run, 'stdout.log'), result.stdout ?? '');
fs.writeFileSync(path.join(run, 'stderr.log'), result.stderr ?? '');
const summary = { suite, sdk, node: process.versions.node, exitCode: result.status, tarball, recovery: path.join(run, 'recovery'), inheritedCredentials: false, cleanup: 'recoverable rename', realSshCalls: false, providerCalls: false };
fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify(summary, null, 2) + '\n');
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
console.log(JSON.stringify({ run, ...summary }));
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;

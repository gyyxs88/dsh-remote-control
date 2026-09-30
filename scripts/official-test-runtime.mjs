// Test-only official SDK resolution and recoverable fixture cleanup.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { registerHooks, syncBuiltinESMExports } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = path.resolve(process.env.REMOTE_TEST_TMP ?? '');
const runs = path.join(repo, 'temp/official-test-runtime');
if (!process.env.REMOTE_TEST_TMP || !fixture.startsWith(runs + path.sep)
  || !fs.statSync(fixture).isDirectory() || fs.lstatSync(fixture).isSymbolicLink()) throw new Error('Use Test-DesktopDevelopment.mjs');
const rc1 = process.env.REMOTE_TEST_SDK === 'rc1';
const sdk = rc1 ? path.resolve(repo, '../../web-validation/releases/dsh-0.2.0-rc.1') : path.resolve(repo, '../sdk/official-0.2.0-rc.2');
const packages = new Map();
let files = 0;
if (!rc1) {
  const manifest = JSON.parse(fs.readFileSync(path.join(sdk, 'manifest.json')));
  if (manifest.formatVersion !== 1 || manifest.packages.length !== 12 || manifest.source.version !== '0.2.0-rc.2') throw new Error('Unexpected official SDK');
  for (const pkg of manifest.packages) {
    const dir = path.join(sdk, 'node_modules', pkg.name);
    for (const file of pkg.files) {
      const full = path.resolve(dir, file.path);
      if (!full.startsWith(dir + path.sep)) throw new Error('SDK path escape');
      const data = fs.readFileSync(full);
      if (data.length !== file.bytes || createHash('sha256').update(data).digest('hex') !== file.sha256) throw new Error('SDK integrity failure');
      files++;
    }
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    if (meta.name !== pkg.name || meta.version !== pkg.version || !pkg.files.some(f => f.path === 'LICENSE')) throw new Error('SDK identity/license mismatch');
    packages.set(pkg.name, { dir, meta });
  }
}
const resolved = new Map();
registerHooks({ resolve(specifier, context, nextResolve) {
  if (!specifier.startsWith('@deepseek-ai/')) return nextResolve(specifier, context);
  const parts = specifier.split('/');
  const name = parts.slice(0, 2).join('/');
  const key = parts.length === 2 ? '.' : './' + parts.slice(2).join('/');
  let pkg = packages.get(name);
  if (!pkg && rc1) {
    const dir = path.join(sdk, 'node_modules', name);
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'package.json')));
    if (meta.name !== name || (name.startsWith('@deepseek-ai/dsh-') && meta.version !== '0.2.0-rc.1')) throw new Error('Web SDK identity/version mismatch');
    packages.set(name, pkg = { dir, meta });
  }
  if (!pkg) throw new Error('Official SDK lacks ' + name);
  const entry = pkg.meta.exports?.[key];
  const target = typeof entry === 'string' ? entry : entry?.import ?? entry?.default ?? (key === '.' ? pkg.meta.main : undefined);
  if (!target) throw new Error('Unsupported official SDK subpath ' + specifier);
  const full = path.resolve(pkg.dir, target);
  if (!full.startsWith(pkg.dir + path.sep)) throw new Error('SDK export escape');
  resolved.set(specifier, { path: full, version: pkg.meta.version, sha256: createHash('sha256').update(fs.readFileSync(full)).digest('hex') });
  return { url: pathToFileURL(full).href, shortCircuit: true };
} });
process.on('exit', () => fs.writeFileSync(path.join(path.dirname(fixture), `sdk-resolution-${process.pid}.json`), JSON.stringify([...resolved], null, 2) + '\n'));

const recovery = path.join(path.dirname(fixture), 'recovery');
fs.mkdirSync(recovery, { recursive: true });
const moves = [];
const preserve = (input, options = {}) => {
  const absolute = path.resolve(input instanceof URL ? fileURLToPath(input) : String(input));
  if (!absolute.startsWith(fixture + path.sep)) throw new Error('Refusing cleanup outside generated fixtures: ' + absolute);
  try { fs.lstatSync(absolute); } catch (error) { if (error.code === 'ENOENT' && options.force) return; throw error; }
  const parent = fs.realpathSync(path.dirname(absolute));
  if (parent !== fixture && !parent.startsWith(fixture + path.sep)) throw new Error('Fixture parent escape');
  const backup = path.join(recovery, String(moves.length));
  fs.renameSync(absolute, backup);
  moves.push({ original: absolute, backup });
  fs.writeFileSync(path.join(recovery, 'moves.json'), JSON.stringify(moves, null, 2) + '\n');
};
fs.rmSync = preserve;
fs.unlinkSync = preserve;
fsp.rm = async (input, options) => preserve(input, options);
fsp.unlink = async (input) => preserve(input);
syncBuiltinESMExports();
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('External network/provider calls disabled in tests');
  return fetchOriginal(input, options);
};
console.log(`OFFICIAL_TEST_SDK ${rc1 ? 'Web rc.1' : 'Desktop rc.2'} verifiedFiles=${files}; fixture cleanup=rename`);

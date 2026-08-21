import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const files = (await readdir('test')).filter((name) => name.endsWith('.test.mjs')).sort().map((name) => `test/${name}`);
const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit', windowsHide: true });
child.on('error', (error) => { console.error(error); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });

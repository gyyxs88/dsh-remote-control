import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const files = [];
for (const directory of ['lib', 'bin']) {
  for (const name of await readdir(directory)) if (name.endsWith('.mjs')) files.push(join(directory, name));
}

for (const file of files.sort()) {
  const exitCode = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--check', file], { stdio: 'inherit', windowsHide: true });
    child.on('error', () => resolve(1));
    child.on('exit', (code) => resolve(code ?? 1));
  });
  if (exitCode !== 0) process.exit(exitCode);
}

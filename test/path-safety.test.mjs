import test from 'node:test';
import assert from 'node:assert/strict';
import { isWithinAllowedRoot } from '../lib/path-safety.mjs';

test('allowed root uses path-relative containment, not string prefix', () => {
  assert.equal(isWithinAllowedRoot('/srv/projects', '/srv/projects/app'), true);
  assert.equal(isWithinAllowedRoot('/srv/projects', '/srv/projects-escape/app'), false);
  assert.equal(isWithinAllowedRoot('/srv/projects', '/srv/other'), false);
});

test('Linux canonical ancestor/symlink enforcement is exercised only on the target platform', { skip: process.platform !== 'linux' }, async () => {
  const { mkdtemp, mkdir, rm, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { assertWithinAllowedRoot } = await import('../lib/path-safety.mjs');
  const root = await mkdtemp(join(tmpdir(), 'dsh-path-safety-'));
  try {
    await mkdir(join(root, 'inside'));
    await symlink('/tmp', join(root, 'escape'), 'dir');
    await assert.rejects(() => assertWithinAllowedRoot(join(root, 'escape', 'new'), root));
    assert.equal(await assertWithinAllowedRoot(join(root, 'inside', 'new'), root), join(root, 'inside', 'new'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

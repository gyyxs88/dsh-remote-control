import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { DshRemoteError } from '../lib/errors.mjs';
import { createInitialHostState, JsonStateStore } from '../lib/state-store.mjs';

test('JsonStateStore enforces a single process lock and releases it on close', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-state-lock-'));
  try {
    const first = await JsonStateStore.open({ dataDir: root });
    await assert.rejects(
      () => JsonStateStore.open({ dataDir: root }),
      (error) => error instanceof DshRemoteError && error.code === 'STATE_LOCKED',
    );
    await first.close();
    const second = await JsonStateStore.open({ dataDir: root });
    await second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('JsonStateStore releases its lock when initial state write fails or state is corrupt', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'dsh-state-corrupt-'));
  const filePath = path.join(root, 'host-state.json');
  try {
    await writeFile(filePath, '{not-json', 'utf8');
    await assert.rejects(
      () => JsonStateStore.open({ dataDir: root }),
      (error) => error instanceof DshRemoteError && error.code === 'STATE_INVALID',
    );
    await writeFile(filePath, `${JSON.stringify(createInitialHostState())}\n`, 'utf8');
    const store = await JsonStateStore.open({ dataDir: root });
    await store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

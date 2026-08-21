import test from 'node:test';
import assert from 'node:assert/strict';
import { validateInstallerInputs } from '../lib/installer-policy.mjs';
import { DshRemoteError } from '../lib/errors.mjs';

const valid = { platform: 'linux', arch: 'x64', uid: 1000, version: '0.1.0', protocolVersion: '1.0', installRoot: '/home/user/.dsh-remote/host', artifact: '/tmp/host.tgz', expectedSha: 'a'.repeat(64), atomic: true, noRoot: true };

test('installer policy rejects root, traversal and missing atomic controls', () => {
  assert.equal(validateInstallerInputs(valid).installRoot, '/home/user/.dsh-remote/host');
  assert.throws(() => validateInstallerInputs({ ...valid, uid: 0 }), DshRemoteError);
  assert.throws(() => validateInstallerInputs({ ...valid, version: '../0.1.0' }), DshRemoteError);
  assert.throws(() => validateInstallerInputs({ ...valid, installRoot: '/home/user/../escape' }), DshRemoteError);
  assert.throws(() => validateInstallerInputs({ ...valid, atomic: false }), DshRemoteError);
  assert.throws(() => validateInstallerInputs({ ...valid, expectedSha: 'bad' }), DshRemoteError);
});

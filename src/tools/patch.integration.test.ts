import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyPatch, buildPatchFromRequest, getContextFragment, getPatchDependencies, verifyWithBuild } from './patch.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jackcode-patch-int-'));
}

test('patch integrates with runtime session scanner symbol index and build verification', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'src', 'feature.js');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(file, 'export const value = 1;\nexport function read() {\n  return value;\n}\n', { encoding: 'utf8', flag: 'w' });

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'update exported value',
    range: { start: 1, end: 1 },
    replacement: 'export const value = 2;',
  }, {
    snapshotDir: join(root, '.snapshots'),
  });

  const runtimeEvents: Array<{ event: string; payload: Record<string, unknown> }> = [];
  const sessionFragments: Array<{ sessionId: string; taskId?: string; fragment: { content: string } }> = [];
  const scannerCalls: Array<Array<{ path: string; type: string }>> = [];
  const symbolUpdates: string[] = [];
  const appliedHooks: string[] = [];

  const result = await applyPatch({
    id: 'integration-plan',
    createdAt: Date.now(),
    patches: [patch],
    impact: {
      filesAffected: 1,
      linesAdded: 1,
      linesRemoved: 1,
      riskLevel: 'low',
    },
    dependencies: { [patch.id]: [] },
  }, {
    sessionId: 'session-1',
    taskId: 'task-1',
    runtime: {
      emit(event, payload) {
        runtimeEvents.push({ event, payload });
      },
      isCancellationRequested() {
        return false;
      },
    },
    session: {
      addContextFragment(sessionId, fragment, taskId) {
        sessionFragments.push({ sessionId, taskId, fragment });
        return true;
      },
    },
    scanner: {
      getIndex() {
        return {
          files: new Map([
            ['src/feature.js', { path: 'src/feature.js', absolutePath: file }],
          ]),
        };
      },
      async scanIncremental(changes) {
        scannerCalls.push(changes);
      },
    },
    symbolIndex: {
      async updateFile(filePath) {
        symbolUpdates.push(filePath);
      },
    },
    build: {
      async run() {
        return { success: true, output: 'build ok\ntest ok', errors: [] };
      },
    },
    autoVerify: true,
    onPatchApplied(appliedPatch) {
      appliedHooks.push(appliedPatch.id);
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.verification?.success, true);
  assert.match(readFileSync(file, 'utf8'), /value = 2/);
  assert.deepEqual(appliedHooks, [patch.id]);
  assert.ok(runtimeEvents.some((entry) => entry.event === 'patch:started'));
  assert.ok(runtimeEvents.some((entry) => entry.event === 'patch:applied'));
  assert.ok(runtimeEvents.some((entry) => entry.event === 'patch:verified'));
  assert.equal(sessionFragments.length, 1);
  assert.equal(sessionFragments[0].sessionId, 'session-1');
  assert.equal(sessionFragments[0].taskId, 'task-1');
  assert.match(sessionFragments[0].fragment.content, /@@/);
  assert.equal(scannerCalls.length, 1);
  assert.equal(scannerCalls[0][0]?.path, file);
  assert.deepEqual(symbolUpdates, [file]);
  assert.deepEqual(getPatchDependencies(patch.id), []);
  assert.match(getContextFragment(patch).content, /value = 2/);
});

test('patch reverts file when build verification fails', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'broken.js');
  const original = 'export const status = "old";\n';
  writeFileSync(file, original);

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'change status',
    range: { start: 1, end: 1 },
    replacement: 'export const status = "new";',
  }, {
    snapshotDir: join(root, '.snapshots'),
  });

  const result = await applyPatch({
    id: 'verification-fail-plan',
    createdAt: Date.now(),
    patches: [patch],
    impact: {
      filesAffected: 1,
      linesAdded: 1,
      linesRemoved: 1,
      riskLevel: 'low',
    },
    dependencies: { [patch.id]: [] },
  }, {
    build: {
      async run() {
        return { success: false, output: 'tests failed', errors: ['tests failed'] };
      },
    },
    autoVerify: true,
  });

  assert.equal(result.success, false);
  assert.equal(result.verification?.success, false);
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.ok(result.events?.some((entry) => entry.type === 'patch:rolled-back'));
});

test('verifyWithBuild returns orchestrated build/test result for a patch', async () => {
  const patch = {
    id: 'patch-verify',
    targetPath: '/tmp/demo.js',
    hunks: [],
    originalChecksum: 'abc',
    reversePatch: { storagePath: '/tmp/demo.json', checksum: 'def' },
    dependencies: [],
  };

  const result = await verifyWithBuild(patch, {
    async build() {
      return { success: true, output: 'build ok', errors: [] };
    },
    async test() {
      return { success: true, output: 'test ok', errors: [] };
    },
  });

  assert.equal(result.success, true);
  assert.equal(result.stage, 'build-test');
  assert.match(result.output, /build ok/);
  assert.match(result.output, /test ok/);
});

test('patch aborts when runtime cancellation is requested before apply', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'cancel.js');
  writeFileSync(file, 'export const cancelled = false;\n');

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'cancel before write',
    range: { start: 1, end: 1 },
    replacement: 'export const cancelled = true;',
  }, {
    snapshotDir: join(root, '.snapshots'),
  });

  const result = await applyPatch({
    id: 'cancel-plan',
    createdAt: Date.now(),
    patches: [patch],
    impact: {
      filesAffected: 1,
      linesAdded: 1,
      linesRemoved: 1,
      riskLevel: 'low',
    },
    dependencies: { [patch.id]: [] },
  }, {
    runtime: {
      isCancellationRequested() {
        return true;
      },
    },
  });

  assert.equal(result.success, false);
  assert.equal(readFileSync(file, 'utf8'), 'export const cancelled = false;\n');
  assert.ok(result.events?.some((entry) => entry.type === 'patch:cancelled'));
});

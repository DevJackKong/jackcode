import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  applyPatch,
  buildPatchFromRequest,
  canRollback,
  generateReversePatch,
  generateUnifiedDiff,
  rollbackPatch,
  summarizeDiff,
  validatePatch,
  cleanupSnapshots,
} from './patch.js';

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jackcode-patch-'));
}

test('buildPatchFromRequest generates unified diff with context lines', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'sample.ts');
  writeFileSync(file, ['alpha', 'beta', 'gamma', 'delta', 'omega'].join('\n'));

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'replace middle section',
    range: { start: 2, end: 4 },
    replacement: ['BETA', 'GAMMA'].join('\n'),
  }, {
    snapshotDir: join(root, '.snapshots'),
  });

  const diff = generateUnifiedDiff(patch);
  assert.match(diff, /--- a\//);
  assert.match(diff, /\+\+\+ b\//);
  assert.match(diff, /@@ -2,3 \+2,2 @@/);
  assert.match(diff, / alpha/);
  assert.match(diff, / omega/);
  assert.match(diff, /-beta/);
  assert.match(diff, /\+BETA/);
});

test('applyPatch supports fuzzy line offset matching and rollback', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'offset.ts');
  writeFileSync(file, ['header', 'alpha', 'beta', 'gamma', 'footer'].join('\n'));

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'replace beta',
    range: { start: 3, end: 3 },
    replacement: 'BETA',
  }, {
    snapshotDir: join(root, '.snapshots'),
  });

  writeFileSync(file, ['inserted', 'header', 'alpha', 'beta', 'gamma', 'footer'].join('\n'));

  const result = await applyPatch({
    id: 'plan-offset',
    createdAt: Date.now(),
    patches: [patch],
    impact: { filesAffected: 1, linesAdded: 1, linesRemoved: 1, riskLevel: 'low' },
  });

  assert.equal(result.success, true);
  assert.match(readFileSync(file, 'utf8'), /BETA/);
  assert.equal(canRollback(patch.id), true);

  const rollback = await rollbackPatch(patch.id);
  assert.equal(rollback.success, true);
  assert.equal(readFileSync(file, 'utf8'), ['inserted', 'header', 'alpha', 'beta', 'gamma', 'footer'].join('\n'));
});

test('applyPatch detects conflict and rolls back previously applied patches', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const fileA = join(root, 'a.ts');
  const fileB = join(root, 'b.ts');
  writeFileSync(fileA, 'one\ntwo\nthree');
  writeFileSync(fileB, 'red\ngreen\nblue');

  const patchA = await buildPatchFromRequest({
    targetPath: fileA,
    description: 'replace two',
    range: { start: 2, end: 2 },
    replacement: 'TWO',
  }, { snapshotDir: join(root, '.snapshots') });

  const patchB = await buildPatchFromRequest({
    targetPath: fileB,
    description: 'replace green',
    range: { start: 2, end: 2 },
    replacement: 'GREEN',
  }, { snapshotDir: join(root, '.snapshots') });

  writeFileSync(fileB, 'red\nchanged\nblue');

  const result = await applyPatch({
    id: 'plan-conflict',
    createdAt: Date.now(),
    patches: [patchA, patchB],
    impact: { filesAffected: 2, linesAdded: 2, linesRemoved: 2, riskLevel: 'medium' },
  });

  assert.equal(result.success, false);
  assert.equal(readFileSync(fileA, 'utf8'), 'one\ntwo\nthree');
  assert.equal(result.failed?.[0]?.failureType, 'checksum_mismatch');
});

test('summarizeDiff includes change stats and risk text', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'summary.ts');
  writeFileSync(file, 'const a = 1;\nconst b = 2;');

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'replace first line',
    range: { start: 1, end: 1 },
    replacement: 'const a = 42;',
  }, { snapshotDir: join(root, '.snapshots') });

  const summary = summarizeDiff([patch]);
  assert.equal(summary.stats.filesChanged, 1);
  assert.equal(summary.fileSummaries.length, 1);
  assert.match(summary.fileSummaries[0].description, /risk/);
});

test('generateReversePatch swaps added and removed lines', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'reverse.ts');
  writeFileSync(file, 'a\nb\nc');

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'replace middle',
    range: { start: 2, end: 2 },
    replacement: 'B',
  }, { snapshotDir: join(root, '.snapshots') });

  const reverse = generateReversePatch(patch);
  assert.deepEqual(reverse.hunks[0].removedLines, patch.hunks[0].addedLines);
  assert.deepEqual(reverse.hunks[0].addedLines, patch.hunks[0].removedLines);
});

test('validatePatch surfaces binary/invalid verification failures', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'broken.json');
  writeFileSync(file, '{"ok":true}');

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'break json',
    range: { start: 1, end: 1 },
    replacement: '{broken',
  }, { snapshotDir: join(root, '.snapshots') });

  const validation = validatePatch(patch);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.length > 0);
});

test('cleanupSnapshots removes expired snapshot entries from disk', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'cleanup.ts');
  writeFileSync(file, 'x\ny\nz');

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'replace y',
    range: { start: 2, end: 2 },
    replacement: 'Y',
  }, { snapshotDir: join(root, '.snapshots') });

  const result = await applyPatch({
    id: 'plan-clean',
    createdAt: Date.now(),
    patches: [patch],
    impact: { filesAffected: 1, linesAdded: 1, linesRemoved: 1, riskLevel: 'low' },
  });

  assert.equal(result.success, true);
  const snapshotPath = join(root, '.snapshots', `${patch.id}.json`);
  assert.equal(existsSync(snapshotPath), true);

  const removed = await cleanupSnapshots(-1);
  assert.ok(removed.includes(patch.id));
  assert.equal(existsSync(snapshotPath), false);
});

test('buildPatchFromRequest flags large file diff notes', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'large.ts');
  const lines = Array.from({ length: 5005 }, (_, i) => `line-${i + 1}`);
  writeFileSync(file, lines.join('\n'));

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'replace one line',
    range: { start: 2500, end: 2500 },
    replacement: 'LINE-2500',
  }, { snapshotDir: join(root, '.snapshots') });

  const diff = generateUnifiedDiff(patch);
  assert.match(diff, /large file, context truncated/);
});

test('applyPatch preserves file permissions when rewriting', async (t) => {
  const root = makeTempDir();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const file = join(root, 'exec.sh');
  writeFileSync(file, 'echo old');
  mkdirSync(join(root, '.snapshots'), { recursive: true });
  chmodSync(file, 0o755);

  const patch = await buildPatchFromRequest({
    targetPath: file,
    description: 'replace line',
    range: { start: 1, end: 1 },
    replacement: 'echo new',
  }, { snapshotDir: join(root, '.snapshots') });

  const result = await applyPatch({
    id: 'plan-mode',
    createdAt: Date.now(),
    patches: [patch],
    impact: { filesAffected: 1, linesAdded: 1, linesRemoved: 1, riskLevel: 'low' },
  });

  assert.equal(result.success, true);
  const mode = statSync(file).mode & 0o777;
  assert.equal(mode, 0o755);
});

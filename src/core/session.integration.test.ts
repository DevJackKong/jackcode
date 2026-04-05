import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from './session.js';
import { RuntimeStateMachine } from './runtime.js';
import type { Patch } from '../types/patch.js';
import type { RunResult } from '../types/test-runner.js';
import type { FileIndex } from '../types/scanner.js';
import type { ContextFragment } from '../types/context.js';

function makeFragment(id: string, content: string, priority: number): ContextFragment {
  return {
    id,
    type: 'doc',
    content,
    timestamp: Date.now(),
    source: `${id}.md`,
    tokenCount: undefined,
    metadata: {
      accessCount: 0,
      lastAccess: Date.now(),
      priority,
      tags: [],
    },
  };
}

function makePatch(targetPath: string): Patch {
  return {
    id: 'patch-1',
    targetPath,
    originalChecksum: 'abc',
    reversePatch: {
      storagePath: '.jackcode/snapshots/patch-1.json',
      checksum: 'def',
    },
    hunks: [
      {
        oldRange: { start: 1, end: 1 },
        newRange: { start: 1, end: 2 },
        contextBefore: [],
        removedLines: ['const a = 1;'],
        addedLines: ['const a = 2;', 'const b = 3;'],
        contextAfter: [],
      },
    ],
  };
}

function makeRunResult(success = true): RunResult {
  return {
    success,
    durationMs: 120,
    output: success ? 'ok' : 'failed',
    errors: success ? [] : ['boom'],
    coverage: { lines: 90, functions: 88, branches: 80, statements: 91 },
  };
}

function makeFileIndex(rootDir: string): FileIndex {
  return {
    rootDir,
    files: new Map([
      ['src/index.ts', {
        path: 'src/index.ts',
        absolutePath: join(rootDir, 'src/index.ts'),
        name: 'index.ts',
        extension: 'ts',
        language: 'typescript',
        size: 20,
        modifiedAt: Date.now(),
        createdAt: Date.now(),
        contentHash: 'hash-1',
        lines: 2,
        stats: { totalLines: 2, codeLines: 2, commentLines: 0, blankLines: 0 },
        gitStatus: 'modified',
      }],
    ]),
    directories: new Map(),
    languages: new Map([
      ['typescript', {
        language: 'typescript',
        fileCount: 1,
        totalLines: 2,
        codeLines: 2,
        commentLines: 0,
        blankLines: 0,
        extensions: ['ts'],
        totalSize: 20,
      }],
    ]),
    generatedAt: Date.now(),
    gitInfo: {
      isRepo: true,
      currentBranch: 'main',
      untrackedFiles: [],
      modifiedFiles: ['src/index.ts'],
      stagedFiles: [],
      conflictFiles: [],
    },
  };
}

test('integrates session lifecycle with runtime, patches, tests, scanner, and context selection', async () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'jackcode-session-int-'));
  const manager = new SessionManager({ persistence: { baseDir, autoSave: false } });
  const session = manager.createSession({
    rootGoal: 'Ship integrated feature',
    contextWindow: { maxTokens: 60, warningThreshold: 0.5, compressionThreshold: 0.6 },
  });

  const runtime = new RuntimeStateMachine({}, { autoPersist: false, autoStart: false, persistencePath: join(baseDir, 'runtime.json') });
  const liveSession = manager.getSession(session.id)!;
  liveSession.attachToRuntime?.(runtime);

  runtime.createTask('runtime task', { id: 'rt-1', priority: 'high' });
  runtime.setPlan('rt-1', {
    estimatedTokens: 800,
    targetModel: 'qwen',
    steps: [{ id: 'step-1', description: 'edit file', targetFiles: ['src/index.ts'], dependencies: [] }],
  });

  const synced = manager.getSession(session.id)!;
  assert.equal(synced.runtimeQueue.queue.length, 1);
  assert.equal(synced.runtimeQueue.queue[0]?.id, 'rt-1');

  const patch = makePatch('src/index.ts');
  const patchRecord = synced.addPatch?.('src/index.ts', patch);
  assert.ok(patchRecord);
  assert.equal(patchRecord?.version, 1);

  const task = manager.pushTask(session.id, 'Run verification');
  assert.ok(task);

  const testRecord = manager.getSession(session.id)!.addTestResult?.(makeRunResult(true));
  assert.ok(testRecord);
  assert.equal(testRecord?.taskId, task?.id);

  const repoRoot = mkdtempSync(join(tmpdir(), 'jackcode-repo-snap-'));
  writeFileSync(join(repoRoot, 'index.ts'), 'export const value = 1;\n', 'utf8');
  const snapshot = makeFileIndex(repoRoot);
  manager.getSession(session.id)!.setRepoSnapshot?.(snapshot);

  const afterSnapshot = manager.getSession(session.id)!;
  assert.equal(afterSnapshot.repoSnapshot?.snapshot.rootDir, repoRoot);
  assert.equal(afterSnapshot.patchHistory.length, 1);
  assert.equal(afterSnapshot.testResults.length, 1);
  assert.equal(afterSnapshot.fileVersions['src/index.ts'], 1);

  manager.addContextFragment(session.id, makeFragment('low', 'low priority '.repeat(10), 0.1));
  manager.addContextFragment(session.id, makeFragment('high', 'high priority '.repeat(10), 1));
  manager.addContextFragment(session.id, makeFragment('mid', 'mid priority '.repeat(10), 0.5));

  const selected = manager.getSession(session.id)!.selectContext?.(30);
  assert.ok(selected);
  assert.ok((selected?.fragments.length ?? 0) >= 1);
  assert.equal(selected?.fragments[0]?.id, 'high');

  rmSync(repoRoot, { recursive: true, force: true });
  rmSync(baseDir, { recursive: true, force: true });
});

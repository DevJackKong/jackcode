import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { RuntimeStateMachine, type ExecutionPlan, type TaskContext } from './runtime.js';
import { SessionManager } from './session.js';
import type { Patch, PatchPlan, PatchResult, RollbackResult } from '../types/patch.js';
import type { FileChange, FileIndex, ScanResult } from '../types/scanner.js';
import type { LoopRunResult } from '../tools/test-runner.js';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'jackcode-runtime-integration-'));

function createPlan(filePath: string): ExecutionPlan {
  return {
    estimatedTokens: 800,
    targetModel: 'qwen',
    steps: [
      {
        id: 'step-1',
        description: 'append integration marker',
        targetFiles: [filePath],
        dependencies: [],
      },
    ],
  };
}

function createLoopResult(overrides: Partial<LoopRunResult> = {}): LoopRunResult {
  return {
    success: true,
    durationMs: 10,
    output: 'build/test ok',
    errors: [],
    stages: [],
    retries: 0,
    prePatchPassed: true,
    postPatchPassed: true,
    classification: 'none',
    ...overrides,
  };
}

test('integrates session, patch, build/test, and repo scanner across full lifecycle', async () => {
  const repoRoot = mkdtempSync(path.join(TMP_DIR, 'repo-'));
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  const targetFile = path.join(repoRoot, 'src', 'index.ts');
  writeFileSync(targetFile, 'export const value = 1;\n');

  const sessionManager = new SessionManager();
  let scanCalls = 0;
  let scanIncrementalCalls = 0;
  let buildCalls = 0;
  let applyCalls = 0;

  const repoScanner = {
    async scan(): Promise<ScanResult> {
      scanCalls += 1;
      return {
        success: true,
        filesProcessed: 1,
        durationMs: 1,
        errors: [],
        index: {
          rootDir: repoRoot,
          files: new Map([
            ['src/index.ts', {
              path: 'src/index.ts',
              absolutePath: targetFile,
              name: 'index.ts',
              extension: 'ts',
              language: 'typescript',
              size: 24,
              modifiedAt: Date.now(),
              createdAt: Date.now(),
              contentHash: 'hash',
              lines: 1,
              stats: { totalLines: 1, codeLines: 1, commentLines: 0, blankLines: 0 },
            }],
          ]),
          directories: new Map(),
          languages: new Map(),
          generatedAt: Date.now(),
        } as FileIndex,
      };
    },
    async scanIncremental(changes: FileChange[]): Promise<FileIndex | null> {
      scanIncrementalCalls += 1;
      assert.deepEqual(changes.map((change) => change.path), ['src/index.ts']);
      return {
        rootDir: repoRoot,
        files: new Map(),
        directories: new Map(),
        languages: new Map(),
        generatedAt: Date.now(),
      } as FileIndex;
    },
    getIndex(): FileIndex | null {
      return null;
    },
  };

  const patchEngine = {
    async buildPatchFromRequest(request: { targetPath: string; insertion?: string }): Promise<Patch> {
      return {
        id: 'patch-1',
        targetPath: request.targetPath,
        hunks: [
          {
            oldRange: { start: 2, end: 1 },
            newRange: { start: 2, end: 2 },
            contextBefore: [],
            removedLines: [],
            addedLines: [request.insertion ?? '// integration'],
            contextAfter: [],
          },
        ],
        originalChecksum: 'orig',
        reversePatch: { storagePath: path.join(repoRoot, '.snapshots/patch-1.json'), checksum: 'rev' },
      };
    },
    validatePatch(): { valid: boolean; errors: string[] } {
      return { valid: true, errors: [] };
    },
    async applyPatch(plan: PatchPlan): Promise<PatchResult> {
      applyCalls += 1;
      assert.equal(plan.patches.length, 1);
      return {
        success: true,
        applied: plan.patches,
        canRollback: true,
      };
    },
    async rollbackPatch(): Promise<RollbackResult> {
      return { success: true, rolledBack: ['patch-1'] };
    },
  };

  const buildTest = {
    async run(): Promise<LoopRunResult> {
      buildCalls += 1;
      return createLoopResult();
    },
  };

  const runtime = new RuntimeStateMachine(
    {
      session: sessionManager,
      executor: {
        execute: async (_task: TaskContext) => ({
          success: true,
          patches: [
            {
              targetPath: targetFile,
              description: 'append integration marker',
              insertion: '// integration marker',
            },
          ],
          summary: 'generated patch request',
        }),
        review: async () => ({ approved: true, summary: 'looks good' }),
      },
      patchEngine,
      buildTest,
      repoScanner,
    },
    {
      repoRoot,
      persistencePath: path.join(repoRoot, '.jackcode/runtime-state.json'),
      autoPersist: false,
      autoStart: false,
    }
  );

  const task = runtime.createTask('integrate runtime', { id: 'task-1' });
  runtime.setPlan(task.id, createPlan(targetFile));

  const result = await runtime.runTask(task.id);
  const session = runtime.getSession(task.id);
  const runtimeSessionTask = session?.tasks.find((entry: { metadata: Record<string, unknown> }) => entry.metadata.runtimeTaskId === task.id);

  assert.equal(result.state, 'completed');
  assert.equal(result.status, 'completed');
  assert.ok(session);
  assert.equal(runtimeSessionTask?.status, 'completed');
  assert.ok(result.checkpointId);
  assert.ok(result.handoff);
  assert.ok(result.artifacts.some((artifact) => artifact.type === 'checkpoint'));
  assert.ok(result.artifacts.some((artifact) => artifact.type === 'patch'));
  assert.ok(result.artifacts.some((artifact) => artifact.path.endsWith('build-test.log')));
  assert.equal(applyCalls, 1);
  assert.equal(buildCalls, 1);
  assert.ok(scanCalls >= 1);
  assert.equal(scanIncrementalCalls, 1);
  assert.ok(runtime.getRepoScanResult()?.success);
});

test('rolls back and blocks task when build/test fails after patch application', async () => {
  const repoRoot = mkdtempSync(path.join(TMP_DIR, 'repo-fail-'));
  mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  const targetFile = path.join(repoRoot, 'src', 'index.ts');
  writeFileSync(targetFile, 'export const value = 1;\n');

  const sessionManager = new SessionManager();
  let rollbackCalls = 0;

  const runtime = new RuntimeStateMachine(
    {
      session: sessionManager,
      executor: {
        execute: async () => ({
          success: true,
          patches: [
            {
              targetPath: targetFile,
              description: 'append integration marker',
              insertion: '// integration marker',
            },
          ],
        }),
        review: async () => ({ approved: true }),
      },
      patchEngine: {
        async buildPatchFromRequest(request): Promise<Patch> {
          return {
            id: 'patch-fail',
            targetPath: request.targetPath,
            hunks: [
              {
                oldRange: { start: 2, end: 1 },
                newRange: { start: 2, end: 2 },
                contextBefore: [],
                removedLines: [],
                addedLines: ['// integration marker'],
                contextAfter: [],
              },
            ],
            originalChecksum: 'orig',
            reversePatch: { storagePath: path.join(repoRoot, '.snapshots/patch-fail.json'), checksum: 'rev' },
          };
        },
        validatePatch() {
          return { valid: true, errors: [] };
        },
        async applyPatch(plan: PatchPlan): Promise<PatchResult> {
          return { success: true, applied: plan.patches, canRollback: true };
        },
        async rollbackPatch(): Promise<RollbackResult> {
          rollbackCalls += 1;
          return { success: true, rolledBack: ['patch-fail'] };
        },
      },
      buildTest: {
        async run(): Promise<LoopRunResult> {
          return createLoopResult({ success: false, errors: ['tests failed'], output: 'tests failed', classification: 'test' });
        },
      },
      repoScanner: {
        async scan(): Promise<ScanResult> {
          return { success: true, filesProcessed: 1, durationMs: 1, errors: [], index: { rootDir: repoRoot, files: new Map(), directories: new Map(), languages: new Map(), generatedAt: Date.now() } as FileIndex };
        },
        async scanIncremental(): Promise<FileIndex | null> {
          return { rootDir: repoRoot, files: new Map(), directories: new Map(), languages: new Map(), generatedAt: Date.now() } as FileIndex;
        },
      },
      repairer: {
        classifyError: (error) => ({
          category: 'transient',
          error,
          reason: error instanceof Error ? error.message : String(error),
          timestamp: Date.now(),
          retryable: true,
        }),
        attemptRecovery: async () => ({
          success: true,
          action: 'rollback',
          newState: 'rolling_back',
          rollbackCheckpointId: 'cp-1',
          message: 'rollback requested',
        }),
      },
    },
    {
      repoRoot,
      persistencePath: path.join(repoRoot, '.jackcode/runtime-state.json'),
      autoPersist: false,
      autoStart: false,
    }
  );

  const task = runtime.createTask('integrate runtime failure path', { id: 'task-fail', maxAttempts: 2 });
  runtime.setPlan(task.id, createPlan(targetFile));
  const result = await runtime.runTask(task.id);

  assert.equal(result.status, 'failed');
  assert.equal(result.state, 'error');
  assert.ok(rollbackCalls >= 1);
  const session = runtime.getSession(task.id);
  const runtimeSessionTask = session?.tasks.find((entry: { metadata: Record<string, unknown> }) => entry.metadata.runtimeTaskId === task.id);
  assert.equal(runtimeSessionTask?.status, 'blocked');
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

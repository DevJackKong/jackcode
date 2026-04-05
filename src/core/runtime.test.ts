import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RepoScanner } from './scanner.js';

import { RuntimeStateMachine, type ExecutionPlan, type TaskContext } from './runtime.js';
import type { HandoffPayload } from '../types/session.js';
import type { ClassifiedFailure, RecoveryResult } from '../types/repairer.js';

const TMP_DIR = mkdtempSync(path.join(os.tmpdir(), 'jackcode-runtime-tests-'));
mkdirSync(TMP_DIR, { recursive: true });

function createPlan(targetModel: 'qwen' | 'gpt54' = 'qwen'): ExecutionPlan {
  return {
    estimatedTokens: 1200,
    targetModel,
    steps: [
      {
        id: 'step-1',
        description: 'Apply change',
        targetFiles: ['src/index.ts'],
        dependencies: [],
      },
    ],
  };
}

function createPersistencePath(name: string): string {
  return path.join(TMP_DIR, `${name}.json`);
}

function createRuntime(options: {
  name: string;
  executor?: {
    execute?: (task: TaskContext) => Promise<{ success: boolean; error?: string }>;
    review?: (task: TaskContext) => Promise<{ approved: boolean; issues?: string[]; summary?: string }>;
  };
  repairer?: {
    classifyError?: (error: unknown) => ClassifiedFailure;
    attemptRecovery?: (context: {
      taskId: string;
      currentState: string;
      remainingRetries: number;
      lastCheckpointId?: string;
    }) => Promise<RecoveryResult>;
  };
  session?: {
    prepareHandoff?: () => HandoffPayload | null;
    createCheckpoint?: () => Promise<{ id: string } | null>;
  };
}) {
  const persistencePath = createPersistencePath(options.name);
  if (existsSync(persistencePath)) {
    rmSync(persistencePath, { force: true });
  }

  const runtime = new RuntimeStateMachine(
    {
      session: options.session
        ? {
            updateTaskStatus: () => true,
            prepareHandoff: options.session.prepareHandoff
              ? () => options.session!.prepareHandoff!()
              : undefined,
            createCheckpoint: options.session.createCheckpoint
              ? async () => options.session!.createCheckpoint!()
              : undefined,
          }
        : undefined,
      executor: options.executor
        ? {
            execute: options.executor.execute
              ? async (task) => options.executor!.execute!(task)
              : async () => ({ success: true }),
            review: options.executor.review
              ? async (task) => options.executor!.review!(task)
              : async () => ({ approved: true }),
          }
        : {
            execute: async () => ({ success: true }),
            review: async () => ({ approved: true }),
          },
      repairer: options.repairer
        ? {
            classifyError:
              options.repairer.classifyError ??
              ((error) => ({
                category: 'unknown',
                error,
                reason: error instanceof Error ? error.message : String(error),
                timestamp: Date.now(),
                retryable: true,
              })),
            attemptRecovery: async (context) =>
              options.repairer!.attemptRecovery
                ? options.repairer!.attemptRecovery({
                    taskId: context.taskId,
                    currentState: context.currentState,
                    remainingRetries: context.remainingRetries,
                    lastCheckpointId: context.lastCheckpointId,
                  })
                : {
                    success: false,
                    action: 'halt',
                    newState: 'error',
                    message: 'no recovery',
                  },
          }
        : undefined,
    },
    {
      persistencePath,
      autoPersist: true,
      autoStart: false,
    }
  );

  return { runtime, persistencePath };
}

test('validates task creation input', () => {
  const { runtime } = createRuntime({ name: 'create-validation' });

  assert.throws(() => runtime.createTask('   '), /Task intent is required/);
  assert.throws(
    () => runtime.createTask('ok', { maxAttempts: 0 }),
    /maxAttempts must be a positive integer/
  );
  assert.throws(
    () => runtime.createTask('ok', { timeoutMs: 0 }),
    /timeoutMs must be a positive number/
  );
});

test('queues higher priority tasks first', () => {
  const { runtime } = createRuntime({ name: 'priority-queue' });

  const low = runtime.createTask('low priority', { id: 'low', priority: 'low' });
  runtime.createTask('critical priority', { id: 'critical', priority: 'critical' });
  runtime.createTask('high priority', { id: 'high', priority: 'high' });

  assert.equal(low.id, 'low');
  const queue = runtime.getQueue();
  assert.deepEqual(queue.map((task) => task.id), ['critical', 'high', 'low']);
});

test('rejects invalid transition without plan', () => {
  const { runtime } = createRuntime({ name: 'transition-validation' });

  runtime.createTask('task', { id: 't1' });
  runtime.transition('t1', 'planning');
  assert.throws(() => runtime.transition('t1', 'executing'), /Transition validation failed/);
});

test('completes full lifecycle planning -> executing -> reviewing -> completed', async () => {
  const events: string[] = [];
  const { runtime } = createRuntime({ name: 'full-lifecycle' });

  runtime.on('state-changed', ({ from, to }) => events.push(`${from}->${to}`));

  runtime.createTask('implement feature', { id: 'task-1' });
  runtime.setPlan('task-1', createPlan('qwen'));
  const result = await runtime.runTask('task-1');

  assert.equal(result.state, 'completed');
  assert.equal(result.status, 'completed');
  assert.deepEqual(events, [
    'idle->planning',
    'planning->executing',
    'executing->reviewing',
    'reviewing->completed',
  ]);
});

test('supports explicit cancellation', () => {
  const { runtime } = createRuntime({ name: 'cancel' });

  runtime.createTask('cancel me', { id: 'cancel-task' });
  const cancelled = runtime.cancelTask('cancel-task', 'User cancelled');

  assert.equal(cancelled.status, 'cancelled');
  assert.equal(runtime.getQueue().length, 0);
  assert.equal(cancelled.lastError?.details?.cancelled, true);
});

test('marks task failed on timeout', async () => {
  const { runtime } = createRuntime({
    name: 'timeout',
    executor: {
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        return { success: true };
      },
      review: async () => ({ approved: true }),
    },
  });

  runtime.createTask('slow task', { id: 'timeout-task', timeoutMs: 10 });
  runtime.setPlan('timeout-task', createPlan());

  const result = await runtime.runTask('timeout-task');
  assert.equal(result.status, 'failed');
  assert.equal(result.state, 'error');
  assert.ok(result.errors.some((entry) => entry.classification === 'timeout'));
});

test('recovers with retry for transient failures', async () => {
  let executeCalls = 0;
  const { runtime } = createRuntime({
    name: 'retry-recovery',
    executor: {
      execute: async () => {
        executeCalls += 1;
        if (executeCalls === 1) {
          return { success: false, error: 'temporary timeout' };
        }
        return { success: true };
      },
      review: async () => ({ approved: true }),
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
        action: 'retry',
        newState: 'retrying',
        message: 'retrying',
      }),
    },
  });

  runtime.createTask('retry task', { id: 'retry-task', maxAttempts: 2 });
  runtime.setPlan('retry-task', createPlan());
  const result = await runtime.runTask('retry-task');

  assert.equal(executeCalls, 2);
  assert.equal(result.state, 'completed');
  assert.equal(result.retryCount, 1);
});

test('uses rollback path when repairer requests rollback and checkpoint exists', async () => {
  let executeCalls = 0;
  const { runtime } = createRuntime({
    name: 'rollback-recovery',
    executor: {
      execute: async () => {
        executeCalls += 1;
        if (executeCalls === 1) {
          return { success: false, error: 'permanent failure' };
        }
        return { success: true };
      },
      review: async () => ({ approved: true }),
    },
    repairer: {
      classifyError: (error) => ({
        category: 'permanent',
        error,
        reason: error instanceof Error ? error.message : String(error),
        timestamp: Date.now(),
        retryable: false,
      }),
      attemptRecovery: async () => ({
        success: true,
        action: 'rollback',
        newState: 'rolling_back',
        rollbackCheckpointId: 'cp-1',
        message: 'rollback',
      }),
    },
    session: {
      createCheckpoint: async () => ({ id: 'cp-1' }),
    },
  });

  runtime.createTask('rollback task', { id: 'rollback-task', sessionId: 'session-1', maxAttempts: 2 });
  runtime.setPlan('rollback-task', createPlan());
  const result = await runtime.runTask('rollback-task');

  assert.equal(executeCalls, 2);
  assert.equal(result.state, 'completed');
  assert.equal(result.checkpointId, 'cp-1');
  assert.ok(result.artifacts.some((artifact) => artifact.type === 'checkpoint'));
});

test('stores handoff during review when session adapter provides one', async () => {
  const handoff: HandoffPayload = {
    sessionId: 'session-42',
    summary: 'handoff summary',
    progress: ['planned'],
    blockers: [],
    decisions: [],
    currentTask: {
      id: 'task',
      parentId: null,
      goal: 'ship feature',
      criteria: [],
      status: 'in-progress',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
    },
    taskStack: [],
    relevantFiles: [],
    expectedActions: ['review'],
    fromModel: 'qwen',
    toModel: 'gpt54',
    timestamp: new Date(),
  };

  const { runtime } = createRuntime({
    name: 'handoff',
    session: {
      prepareHandoff: () => handoff,
    },
  });

  runtime.createTask('handoff task', { id: 'handoff-task', sessionId: 'session-42' });
  runtime.setPlan('handoff-task', createPlan());
  const result = await runtime.runTask('handoff-task');

  assert.equal(result.state, 'completed');
  assert.equal(result.handoff?.summary, 'handoff summary');
  assert.ok(result.artifacts.some((artifact) => artifact.type === 'handoff'));
});

test('persists and recovers queued tasks', () => {
  const { runtime, persistencePath } = createRuntime({ name: 'persist-recover' });

  runtime.createTask('first', { id: 'first', priority: 'normal' });
  runtime.createTask('second', { id: 'second', priority: 'critical' });
  runtime.persist();

  const recoveredRuntime = new RuntimeStateMachine(
    {
      executor: {
        execute: async () => ({ success: true }),
        review: async () => ({ approved: true }),
      },
    },
    { persistencePath, autoPersist: false }
  );

  const restored = recoveredRuntime.recover();
  assert.equal(restored.length, 2);
  assert.deepEqual(recoveredRuntime.getQueue().map((task) => task.id), ['second', 'first']);
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

test('runtime scans repo and stores scanner snapshot for session', async () => {
  const repoDir = mkdtempSync(path.join(TMP_DIR, 'scanner-runtime-'));
  mkdirSync(path.join(repoDir, 'src'), { recursive: true });
  writeFileSync(path.join(repoDir, 'src/index.js'), 'export const ok = true;\n', 'utf8');

  const scanner = new RepoScanner({ rootDir: repoDir });
  let snapshotRoot: string | null = null;

  const runtime = new RuntimeStateMachine(
    {
      scanner,
      session: {
        updateTaskStatus: () => true,
        setScannerSnapshot: (_sessionId: string, snapshot: unknown) => {
          snapshotRoot = (snapshot as { rootDir?: string })?.rootDir ?? null;
          return true;
        },
      },
      executor: {
        execute: async () => ({ success: true }),
        review: async () => ({ approved: true }),
      },
    },
    { autoPersist: false }
  );

  runtime.createTask('scan repo', { id: 'scan-task', sessionId: 'session-1' });
  runtime.setPlan('scan-task', createPlan());
  await runtime.runTask('scan-task');

  assert.equal(snapshotRoot, repoDir);
  rmSync(repoDir, { recursive: true, force: true });
});

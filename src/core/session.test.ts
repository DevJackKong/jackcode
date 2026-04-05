import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SessionManager } from './session.js';
import { JackClawMemoryAdapter } from '../adapters/jackclaw/memory-adapter.js';
import type { ContextFragment } from '../types/context.js';

function fragment(id: string, content: string, tags: string[] = []): ContextFragment {
  return {
    id,
    type: 'code',
    content,
    source: `src/${id}.ts`,
    timestamp: Date.now(),
    metadata: {
      accessCount: 0,
      lastAccess: Date.now(),
      priority: 0.7,
      tags,
    },
  };
}

test('creates sessions and manages lifecycle/events', () => {
  const manager = new SessionManager();
  const events: string[] = [];

  manager.on('session-created', () => events.push('created'));
  manager.on('state-change', ({ from, to }) => events.push(`${from}->${to}`));
  manager.on('session-closed', () => events.push('closed'));

  const session = manager.createSession({ rootGoal: 'Build session manager' });
  assert.equal(session.state, 'active');
  assert.equal(session.rootGoal, 'Build session manager');
  assert.equal(session.taskStack.length, 1);
  assert.equal(session.currentTask?.goal, 'Build session manager');

  assert.equal(manager.pauseSession(session.id), true);
  assert.equal(manager.resumeSession(session.id), true);
  assert.equal(manager.closeSession(session.id), true);

  const updated = manager.getSession(session.id);
  assert.equal(updated?.state, 'closed');
  assert.ok(updated?.closedAt instanceof Date);
  assert.deepEqual(events, ['created', 'created->active', 'active->paused', 'paused->active', 'active->closed', 'closed']);
});

test('supports hierarchical tasks, goal tree, checkpoints, and restore', async () => {
  const manager = new SessionManager();
  const session = manager.createSession({ rootGoal: 'Implement feature X' });

  const taskA = manager.pushTask(session.id, 'Write tests', {
    notes: ['Decision: test-first | reduce regression risk'],
    criteria: ['cover happy path'],
  });
  assert.ok(taskA);

  manager.addTaskNote(session.id, taskA!.id, 'Capture edge cases');
  manager.addContextFragment(session.id, fragment('f1', 'console.log("hello")', ['critical']), taskA!.id);

  const tempFile = join(mkdtempSync(join(tmpdir(), 'jackcode-session-')), 'sample.ts');
  writeFileSync(tempFile, 'export const value = 1;\n', 'utf-8');

  const checkpoint = await manager.createCheckpoint(session.id, [tempFile], {
    tag: 'before-refactor',
    notes: 'safe restore point',
    cursorPositions: {
      [tempFile]: { line: 3, column: 5 },
    },
  });
  assert.ok(checkpoint);
  assert.equal(checkpoint?.tag, 'before-refactor');
  assert.equal(checkpoint?.cursorPositions.get(tempFile)?.line, 3);

  manager.addTaskNote(session.id, taskA!.id, 'Post-checkpoint note');
  const restored = manager.restoreCheckpoint(session.id, 'before-refactor');
  assert.equal(restored, true);

  const restoredSession = manager.getSession(session.id);
  const restoredTask = restoredSession?.tasks.find((task) => task.id === taskA!.id);
  assert.ok(restoredTask);
  assert.equal(restoredTask?.notes.includes('Post-checkpoint note'), false);
  assert.equal(restoredSession?.recoveryState.recoveredFromCheckpointId, checkpoint?.id);

  const goals = manager.getGoalHierarchy(session.id);
  assert.equal(goals.length, 2);
  assert.equal(goals[0]?.children.length, 1);

  const popped = manager.popTask(session.id);
  assert.equal(popped?.id, taskA?.id);
  assert.equal(popped?.status, 'completed');
});

test('persists and recovers session state from disk', () => {
  const baseDir = mkdtempSync(join(tmpdir(), 'jackcode-persist-'));
  const manager = new SessionManager({
    persistence: { baseDir, autoSave: false },
  });

  const session = manager.createSession({ rootGoal: 'Persist me' });
  const subtask = manager.pushTask(session.id, 'Nested task');
  assert.ok(subtask);
  manager.addContextFragment(session.id, fragment('persist', 'important context'));
  manager.recordModelUsage(session.id, 'gpt-5.4', 100, 50, 0.02, { latencyMs: 500, success: true });

  const path = manager.saveSession(session.id);
  assert.ok(path);

  const recoveredManager = new SessionManager({
    persistence: { baseDir, autoSave: false },
  });

  const recovered = recoveredManager.recoverSession(session.id);
  assert.ok(recovered);
  assert.equal(recovered?.source, 'persistence');
  assert.equal(recovered?.session.rootGoal, 'Persist me');
  assert.equal(recovered?.session.tasks.length, 2);
  assert.equal(recovered?.session.contextFragments.length, 1);
  assert.equal(recovered?.session.modelUsage.length, 1);
});

test('compresses context when token window is exceeded', () => {
  const manager = new SessionManager();
  const session = manager.createSession({
    rootGoal: 'Compress context',
    contextWindow: { maxTokens: 80, warningThreshold: 0.5, compressionThreshold: 0.6 },
  });

  manager.addContextFragment(session.id, fragment('a', 'a'.repeat(160), ['critical']));
  manager.addContextFragment(session.id, fragment('b', 'b'.repeat(160)));
  manager.addContextFragment(session.id, fragment('c', 'c'.repeat(160)));

  assert.equal(manager.shouldCompressContext(session.id), true);
  const result = manager.compressContext(session.id, 30);
  assert.ok(result);
  assert.equal(result?.triggered, true);
  assert.ok((result?.afterTokens ?? 999) <= 30);

  const window = manager.getContextWindow(session.id);
  assert.ok(window?.lastCompressedAt instanceof Date);
  assert.ok((window?.currentTokens ?? 999) <= 30);
});

test('integrates with memory adapter for push and pull', async () => {
  const adapter = new JackClawMemoryAdapter({
    memoryPath: '/tmp/jackclaw-memory',
    defaultMode: 'bidirectional',
    autoSyncInterval: 0,
    maxBatchSize: 100,
    defaultTtl: 0,
  });

  const manager = new SessionManager({ memoryAdapter: adapter });
  const session = manager.createSession({ rootGoal: 'Sync memory' });

  const task = manager.pushTask(session.id, 'Capture learnings', {
    notes: ['Decision: prefer adapter sync | centralize durable memory'],
  });
  assert.ok(task);
  manager.addContextFragment(session.id, fragment('mem1', 'context to push', ['session-tag']));
  manager.failTask(session.id, task!.id, 'network failed once');

  const pushed = await manager.pushMemory(session.id, { tags: ['project-x'] });
  assert.ok(pushed);
  assert.ok((pushed?.result.pushed ?? 0) >= 3);

  const pulledSession = manager.createSession({ rootGoal: 'Bootstrap from memory' });
  const pulled = await manager.pullMemory(pulledSession.id, { limit: 10 });
  assert.ok(pulled);
  assert.equal(pulled?.result.pulled, 0);

  const sameSessionPulled = await manager.pullMemory(session.id, { limit: 20 });
  assert.ok(sameSessionPulled);
  assert.ok((sameSessionPulled?.result.pulled ?? 0) > 0);

  const updated = manager.getSession(session.id);
  assert.ok((updated?.contextFragments.length ?? 0) > 1);
  assert.ok(updated?.lastMemorySyncAt instanceof Date);
});

test('tracks model usage totals and per-model performance metrics', () => {
  const manager = new SessionManager();
  const session = manager.createSession({ rootGoal: 'Track usage' });

  manager.recordModelUsage(session.id, 'qwen', 100, 40, 0.01, { latencyMs: 200, success: true });
  manager.recordModelUsage(session.id, 'qwen', 50, 20, 0.005, { latencyMs: 400, success: false });
  manager.recordModelUsage(session.id, 'gpt-5.4', 300, 120, 0.12, { latencyMs: 900, success: true });

  const totals = manager.getModelUsageTotals(session.id);
  assert.equal(totals.totalTokensIn, 450);
  assert.equal(totals.totalTokensOut, 180);
  assert.equal(totals.totalTokens, 630);
  assert.equal(totals.totalCost, 0.135);
  assert.equal(totals.successRate, 2 / 3);
  assert.equal(totals.byModel.qwen.calls, 2);
  assert.equal(totals.byModel.qwen.averageLatencyMs, 300);
  assert.equal(totals.byModel.qwen.successRate, 0.5);
  assert.equal(totals.byModel['gpt-5.4'].totalTokens, 420);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JackClawCollaborationAdapter,
  type SubagentTask,
} from './collaboration.ts';

function createTask(taskId: string, priority = 0.5, overrides: Partial<SubagentTask> = {}): SubagentTask {
  return {
    taskId,
    sessionId: 'session-1',
    goal: `goal-${taskId}`,
    context: {
      files: [],
      fragments: [],
      constraints: [],
    },
    expectedOutput: {
      type: 'analysis',
      format: 'text',
    },
    timeout: 100,
    priority,
    handoff: {
      allow: true,
    },
    ...overrides,
  };
}

test('distributes tasks across least-loaded nodes with priority ordering', async () => {
  const adapter = new JackClawCollaborationAdapter({ maxConcurrent: 2, maxTasksPerNode: 1 }, {
    timer: async () => {},
  });
  adapter.registerNode({ nodeId: 'node-a', capacity: 1, loadScore: 0.2, status: 'online' });
  adapter.registerNode({ nodeId: 'node-b', capacity: 1, loadScore: 0.1, status: 'online' });

  const high = await adapter.spawn(createTask('high', 1));
  const low = await adapter.spawn(createTask('low', 0.1));

  const [highResult, lowResult] = await Promise.all([adapter.waitFor(high), adapter.waitFor(low)]);

  assert.equal(highResult.status, 'success');
  assert.equal(lowResult.status, 'success');

  const distribution = adapter.getTaskDistribution();
  assert.deepEqual(Object.keys(distribution).sort(), ['node-a', 'node-b']);
  assert.equal(distribution['node-a'].length + distribution['node-b'].length, 2);

  const metrics = adapter.getMetrics();
  assert.equal(metrics.completedTasks, 2);
  assert.equal(metrics.activeTasks, 0);
});

test('supports direct and broadcast messaging with ordering metadata', async () => {
  const adapter = new JackClawCollaborationAdapter({}, { timer: async () => {} });
  adapter.registerNode({ nodeId: 'node-a', capacity: 1, status: 'online' });
  adapter.registerNode({ nodeId: 'node-b', capacity: 1, status: 'online' });
  adapter.registerNode({ nodeId: 'node-c', capacity: 1, status: 'online' });

  const direct = await adapter.sendMessage('node-a', 'node-b', { kind: 'hello' }, { channel: 'ops', ordering: 'per-channel' });
  const broadcast = await adapter.broadcast('node-a', { kind: 'sync' }, 'all');
  const log = adapter.getMessageLog();

  assert.equal(log.length, 2);
  assert.equal(direct.sequence < broadcast.sequence, true);
  assert.deepEqual(direct.recipients, ['node-b']);
  assert.deepEqual(broadcast.recipients.sort(), ['node-b', 'node-c']);
  assert.equal(log[0].channel, 'ops');
  assert.equal(log[1].ordering, 'global');
});

test('detects suspect/offline nodes and exposes health metrics', () => {
  let now = 1_000;
  const adapter = new JackClawCollaborationAdapter({ nodeHeartbeatTimeoutMs: 50 }, {
    now: () => now,
    timer: async () => {},
  });
  adapter.registerNode({ nodeId: 'node-a', capacity: 1, status: 'online' });
  adapter.registerNode({ nodeId: 'node-b', capacity: 1, status: 'online' });

  now += 60;
  let health = adapter.monitorNodes();
  assert.equal(health.find((entry) => entry.nodeId === 'node-a')?.status, 'suspect');

  now += 60;
  health = adapter.monitorNodes();
  assert.equal(health.find((entry) => entry.nodeId === 'node-a')?.status, 'offline');
  assert.equal(adapter.getMetrics().offlineNodes, 2);
});

test('supports consensus, lock coordination, and deadlock prevention', async () => {
  const adapter = new JackClawCollaborationAdapter({}, { timer: async () => {} });
  adapter.registerNode({ nodeId: 'node-a', capacity: 1, status: 'online' });
  adapter.registerNode({ nodeId: 'node-b', capacity: 1, status: 'online' });

  const acquired = await adapter.acquireLock('repo', 'node-a');
  assert.equal(acquired, true);

  const secondAcquire = await adapter.acquireLock('repo', 'node-b');
  assert.equal(secondAcquire, false);

  await adapter.acquireLock('cache', 'node-b');
  await assert.rejects(() => adapter.acquireLock('cache', 'node-a'), /Deadlock detected/);

  const consensus = await adapter.buildConsensus('task-1', ['node-a', 'node-b'], {
    'node-a': true,
    'node-b': false,
  });
  assert.equal(consensus.reached, false);
  assert.deepEqual(consensus.approvals, ['node-a']);
});

test('supports clean handoff, resume, and work stealing', async () => {
  const adapter = new JackClawCollaborationAdapter({ maxConcurrent: 1, maxTasksPerNode: 1 }, {
    timer: async () => new Promise((resolve) => setImmediate(resolve)),
  });
  adapter.registerNode({ nodeId: 'node-a', capacity: 2, loadScore: 0.1, status: 'online' });
  adapter.registerNode({ nodeId: 'node-b', capacity: 1, loadScore: 0.1, status: 'online' });

  const handle1 = await adapter.spawn(createTask('task-1', 0.9, { handoff: { allow: true } }), { preferredNodeId: 'node-a' });
  const handle2 = await adapter.spawn(createTask('task-2', 0.8, { handoff: { allow: true } }), { preferredNodeId: 'node-a' });

  const stolenTaskId = adapter.stealWork('node-b');
  assert.ok(stolenTaskId === 'task-1' || stolenTaskId === 'task-2');

  const chosenTaskId = stolenTaskId ?? 'task-1';
  const assignedBeforeResume = adapter.getTaskStatus(chosenTaskId)?.assignedNodeId;
  if (assignedBeforeResume !== 'node-b') {
    const handoff = await adapter.handoffTask(chosenTaskId, 'node-b', 'manual');
    assert.equal(handoff.toNodeId, 'node-b');
  }

  const resumed = await adapter.resumeTask(chosenTaskId);
  assert.equal(resumed.assignedNodeId, 'node-b');

  const [result1, result2] = await Promise.all([adapter.waitFor(handle1), adapter.waitFor(handle2)]);
  assert.equal(result1.status, 'success');
  assert.equal(result2.status, 'success');

  const taskStatus = adapter.getTaskStatus(chosenTaskId);
  assert.ok(taskStatus);
  assert.ok((taskStatus?.handoffs.length ?? 0) >= 1);
});

test('aggregates outputs and monitoring data across tasks', async () => {
  const adapter = new JackClawCollaborationAdapter({ maxConcurrent: 2 }, { timer: async () => {} });
  adapter.registerNode({ nodeId: 'node-a', capacity: 2, status: 'online' });
  adapter.registerNode({ nodeId: 'node-b', capacity: 2, status: 'online' });

  const fileTask = await adapter.spawn(createTask('files', 0.7, {
    expectedOutput: { type: 'files', format: 'txt' },
  }));
  const verifyTask = await adapter.spawn(createTask('verify', 0.6, {
    expectedOutput: { type: 'verification', format: 'boolean' },
  }));

  const results = await Promise.all([adapter.waitFor(fileTask), adapter.waitFor(verifyTask)]);
  const aggregated = adapter.aggregate(results);

  assert.equal(aggregated.allSuccess, true);
  assert.equal(aggregated.combined.files.length, 1);
  assert.deepEqual(aggregated.combined.verifications, [true]);
  assert.equal(aggregated.totals.tokensUsed > 0, true);
  assert.equal(adapter.getNodeHealth().length, 2);
});

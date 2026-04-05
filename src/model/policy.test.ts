import test from 'node:test';
import assert from 'node:assert/strict';

import { ModelPolicyEngine } from './policy.js';
import type { TaskContext } from './types/policy.js';

function createTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    taskId: overrides.taskId ?? `task-${Math.random().toString(16).slice(2)}`,
    taskType: overrides.taskType ?? 'simple_edit',
    files: overrides.files ?? ['src/index.ts'],
    intent: overrides.intent ?? 'adjust code path',
    estimatedTokens: overrides.estimatedTokens ?? 1200,
    complexity: overrides.complexity,
    requiresReasoning: overrides.requiresReasoning ?? false,
    failureCount: overrides.failureCount ?? 0,
    urgency: overrides.urgency ?? 'normal',
    sessionId: overrides.sessionId,
    maxCostUsd: overrides.maxCostUsd,
    batchable: overrides.batchable,
    batchSize: overrides.batchSize,
    preferCached: overrides.preferCached,
    overrideModel: overrides.overrideModel,
    metadata: overrides.metadata,
  };
}

test('routes simple edits to qwen with early termination optimization', () => {
  const engine = new ModelPolicyEngine();
  const decision = engine.selectModel(createTask());

  assert.equal(decision.selectedModel, 'qwen');
  assert.equal(decision.mode, 'normal');
  assert.equal(decision.earlyTerminationSuggested, true);
  assert.ok(decision.appliedOptimizations?.includes('early_termination'));
});

test('forces gpt54 for final verification tasks', () => {
  const engine = new ModelPolicyEngine();
  const decision = engine.selectModel(
    createTask({
      taskType: 'final_verification',
      estimatedTokens: 8000,
      requiresReasoning: true,
      complexity: 'high',
    })
  );

  assert.equal(decision.selectedModel, 'gpt54');
  assert.equal(decision.mode, 'forced');
  assert.ok(decision.appliedRules?.includes('verification_requires_gpt54'));
});

test('supports manual override handling when model can satisfy task', () => {
  const engine = new ModelPolicyEngine();
  const decision = engine.selectModel(
    createTask({
      taskType: 'debug',
      estimatedTokens: 6000,
      requiresReasoning: true,
      overrideModel: 'deepseek',
    })
  );

  assert.equal(decision.selectedModel, 'deepseek');
  assert.equal(decision.overrideApplied, true);
  assert.equal(decision.mode, 'overridden');
  assert.ok(decision.alerts?.some((alert) => alert.code === 'policy.override'));
});

test('rejects invalid override when model lacks required capability', () => {
  const engine = new ModelPolicyEngine();

  assert.throws(
    () =>
      engine.selectModel(
        createTask({
          requiresReasoning: true,
          overrideModel: 'qwen',
          estimatedTokens: 4000,
        })
      ),
    /cannot handle task/
  );
});

test('reuses cached decision when task signature matches and caching is preferred', () => {
  const engine = new ModelPolicyEngine();
  const task = createTask({ preferCached: true, estimatedTokens: 5000 });

  const first = engine.selectModel(task);
  const second = engine.selectModel(task);

  assert.equal(first.selectedModel, second.selectedModel);
  assert.equal(second.cacheHit, true);
  assert.match(second.reasoning, /cached/);
  assert.ok(second.appliedOptimizations?.includes('cache_reuse'));
});

test('tracks cost totals and produces breakdown, dashboard, trends, and exports', () => {
  const engine = new ModelPolicyEngine();

  engine.trackUsage('task-a', {
    model: 'qwen',
    inputTokens: 1000,
    outputTokens: 500,
    latencyMs: 1200,
    sessionId: 'session-1',
    taskType: 'simple_edit',
  });
  engine.trackUsage('task-b', {
    model: 'deepseek',
    inputTokens: 1500,
    outputTokens: 600,
    latencyMs: 2500,
    sessionId: 'session-1',
    taskType: 'debug',
    terminatedEarly: true,
  });

  const report = engine.getCostReport();

  assert.equal(report.summary.totalTasks, 2);
  assert.ok(report.summary.totalCost > 0);
  assert.equal(report.byModel.qwen.count, 1);
  assert.equal(report.byModel.deepseek.count, 1);
  assert.ok(report.dashboard.totals.totalTokens > 0);
  assert.ok(report.breakdown.byTaskType.simple_edit.cost > 0);
  assert.ok(report.breakdown.bySession['session-1'].count === 2);
  assert.ok(Array.isArray(report.trends.daily));
  assert.equal(typeof report.export.json, 'string');
  assert.match(report.export.csv, /taskId,sessionId,taskType/);
});

test('enforces per-task, session, daily, weekly, and monthly budgets', () => {
  const engine = new ModelPolicyEngine({
    policy: {
      defaultModel: 'qwen',
      complexityThresholds: { low: 1000, medium: 10000, high: 50000 },
      escalationChain: ['qwen', 'deepseek', 'gpt54'],
      costLimits: {
        perTask: 0.05,
        perSession: 0.06,
        perDay: 0.07,
        perWeek: 0.08,
        perMonth: 0.09,
      },
    },
  });

  engine.trackUsage('spent', {
    model: 'gpt54',
    inputTokens: 1000,
    outputTokens: 500,
    latencyMs: 1000,
    taskType: 'debug',
  });

  const blocked = engine.checkBudget(0.08);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.violatedWindow, 'task');

  const sessionBlocked = engine.checkBudget(0.05);
  assert.equal(sessionBlocked.allowed, false);
  assert.equal(sessionBlocked.violatedWindow, 'session');
});

test('downgrades model when budget pressure prevents expensive route', () => {
  const engine = new ModelPolicyEngine({
    policy: {
      defaultModel: 'qwen',
      complexityThresholds: { low: 1000, medium: 10000, high: 50000 },
      escalationChain: ['qwen', 'deepseek', 'gpt54'],
      costLimits: {
        perTask: 0.02,
        perSession: 1,
        perDay: 2,
        perWeek: 3,
        perMonth: 4,
      },
    },
  });

  const decision = engine.selectModel(
    createTask({
      taskType: 'final_verification',
      estimatedTokens: 12000,
      requiresReasoning: true,
      complexity: 'high',
    })
  );

  assert.equal(decision.mode, 'downgraded');
  assert.notEqual(decision.selectedModel, 'gpt54');
  assert.ok(decision.reasoning.includes('Downgraded due to'));
});

test('allocates and refunds per-task budgets', () => {
  const engine = new ModelPolicyEngine({
    policy: {
      defaultModel: 'qwen',
      complexityThresholds: { low: 1000, medium: 10000, high: 50000 },
      escalationChain: ['qwen', 'deepseek', 'gpt54'],
      costLimits: {
        perTask: 0.05,
        perSession: 1,
        perDay: 2,
        perWeek: 3,
        perMonth: 4,
      },
    },
  });

  const allocation = engine.allocateBudget('debug', 'task-budget', 0.03);
  assert.equal(allocation.approved, true);
  assert.equal(allocation.allocated, 0.03);

  const refunded = engine.refundBudget('task-budget');
  assert.equal(refunded, true);
});

test('supports dynamic policy updates and validation', () => {
  const engine = new ModelPolicyEngine();

  engine.updatePolicy({
    policy: {
      costLimits: {
        perTask: 0.3,
        perSession: 3,
        perDay: 10,
        perWeek: 25,
        perMonth: 90,
      },
    },
    optimization: {
      batchMinItems: 2,
    },
  });

  const config = engine.getConfig();
  assert.equal(config.policy.costLimits.perWeek, 25);
  assert.equal(config.optimization.batchMinItems, 2);

  assert.throws(
    () =>
      engine.updatePolicy({
        policy: {
          costLimits: {
            perTask: 5,
            perSession: 1,
            perDay: 2,
            perWeek: 3,
            perMonth: 4,
          },
        },
      }),
    /increase from task -> month/
  );
});

test('adds and removes custom rules for routing', () => {
  const engine = new ModelPolicyEngine();

  engine.addRule({
    name: 'custom_force_qwen',
    priority: 999,
    condition: (task) => task.metadata?.['eco'] === true,
    action: () => ({ modelPreference: ['qwen'], forceModel: true }),
  });

  const forced = engine.selectModel(
    createTask({
      taskType: 'debug',
      requiresReasoning: false,
      metadata: { eco: true },
    })
  );
  assert.equal(forced.selectedModel, 'qwen');

  const removed = engine.removeRule('custom_force_qwen');
  assert.equal(removed, true);
});

test('generates warning alerts when budget utilization crosses thresholds', () => {
  const engine = new ModelPolicyEngine({
    policy: {
      defaultModel: 'qwen',
      complexityThresholds: { low: 1000, medium: 10000, high: 50000 },
      escalationChain: ['qwen', 'deepseek', 'gpt54'],
      costLimits: {
        perTask: 1,
        perSession: 1,
        perDay: 2,
        perWeek: 3,
        perMonth: 4,
      },
    },
    warningThresholds: {
      session: 0.5,
      daily: 0.5,
      weekly: 0.5,
      monthly: 0.5,
    },
  });

  engine.trackUsage('alert-task', {
    model: 'gpt54',
    inputTokens: 30000,
    outputTokens: 10000,
    latencyMs: 5000,
    taskType: 'final_verification',
  });

  const alerts = engine.getAlerts();
  assert.ok(alerts.some((alert) => alert.code === 'budget.session_threshold'));
  assert.ok(alerts.some((alert) => alert.code === 'budget.daily_threshold'));
});

test('applies batching and compression optimizations for large batchable work', () => {
  const engine = new ModelPolicyEngine({
    optimization: {
      batchMinItems: 2,
      cacheReuseThresholdTokens: 2000,
      earlyTerminationTokenRatio: 0.25,
      compressionRatio: 0.5,
    },
  });

  const decision = engine.selectModel(
    createTask({
      taskType: 'batch_operation',
      files: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      batchable: true,
      batchSize: 4,
      estimatedTokens: 20000,
      requiresReasoning: false,
    })
  );

  assert.equal(decision.batched, true);
  assert.ok(decision.appliedOptimizations?.includes('batching'));
  assert.ok(decision.appliedOptimizations?.includes('compressed_context'));
  assert.ok((decision.estimatedTokens ?? 0) < 20000);
});

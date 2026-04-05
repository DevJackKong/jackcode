import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RetryManager,
  CircuitBreaker,
  CircuitBreakerOpenError,
  RecoveryEngine,
  RecoveryMonitor,
  PermanentRecoveryError,
  TransientRecoveryError,
  SafetyGuardian,
  TimeoutRecoveryError,
  type RollbackPlan,
} from './recovery.js';

test('RetryManager retries transient failures with eventual success', async () => {
  let attempts = 0;
  const monitor = new RecoveryMonitor();
  const manager = new RetryManager(
    { jitter: false, baseDelayMs: 1, maxDelayMs: 5, backoffMultiplier: 2, maxRetries: 2, retryableErrors: ['ETIMEDOUT'] },
    undefined,
    monitor
  );

  const result = await manager.executeWithRecovery(async () => {
    attempts++;
    if (attempts < 3) throw new TransientRecoveryError('temporary timeout', 'ETIMEDOUT');
    return 'ok';
  });

  assert.equal(result.success, true);
  assert.equal(result.value, 'ok');
  assert.equal(result.attempts, 3);
  assert.equal(result.retryHistory.length, 2);
  assert.equal(monitor.getMetrics().successfulOperations, 1);
});

test('RetryManager enforces timeout and can use fallback', async () => {
  const manager = new RetryManager({ jitter: false, baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 2, maxRetries: 1, retryableErrors: ['TIMEOUT'] });
  const result = await manager.executeWithRecovery(
    async () => new Promise<string>((resolve) => setTimeout(() => resolve('slow'), 30)),
    {
      timeoutMs: 5,
      fallback: () => 'fallback',
      validateResult: (value) => value.length > 0,
    }
  );

  assert.equal(result.success, true);
  assert.equal(result.value, 'fallback');
});

test('RetryManager performs cleanup between retries', async () => {
  let cleaned = 0;
  let attempts = 0;
  const manager = new RetryManager({ jitter: false, baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 2, maxRetries: 1, retryableErrors: ['ETIMEDOUT'] });

  const result = await manager.executeWithRecovery(
    async () => {
      attempts++;
      throw new TimeoutRecoveryError('timed out');
    },
    { cleanup: () => { cleaned++; } }
  );

  assert.equal(result.success, false);
  assert.equal(attempts, 2);
  assert.equal(cleaned, 1);
});

test('CircuitBreaker opens after threshold and rejects until timeout window passes', async () => {
  const breaker = new CircuitBreaker({ failureThreshold: 2, successThreshold: 1, timeoutMs: 10 });

  await assert.rejects(() => breaker.call(async () => { throw new Error('boom-1'); }));
  await assert.rejects(() => breaker.call(async () => { throw new Error('boom-2'); }));
  assert.equal(breaker.getState(), 'OPEN');
  await assert.rejects(() => breaker.call(async () => 'nope'), CircuitBreakerOpenError);

  await new Promise((resolve) => setTimeout(resolve, 15));
  const value = await breaker.call(async () => 'recovered');
  assert.equal(value, 'recovered');
  assert.equal(breaker.getState(), 'CLOSED');
});

test('SafetyGuardian detects loop patterns and guardrail violations', () => {
  const guardian = new SafetyGuardian({ maxRetriesPerTask: 2, maxConcurrentRetries: 1, totalTimeoutMs: 1, memoryLimitMb: 10, enableLoopDetection: true });
  guardian.incrementTaskRetry('task-loop');
  guardian.incrementTaskRetry('task-loop');
  guardian.incrementTaskRetry('task-loop');

  assert.equal(guardian.detectLoop('same-pattern'), false);
  assert.equal(guardian.detectLoop('same-pattern'), false);
  assert.equal(guardian.detectLoop('same-pattern'), true);

  const check = guardian.checkLimits({ taskId: 'task-loop', activeRetries: 2, memoryMb: 20 });
  assert.equal(check.passed, false);
  assert.ok(check.violations.some((violation) => violation.guardrail === 'maxRetriesPerTask'));
  assert.ok(check.violations.some((violation) => violation.guardrail === 'maxConcurrentRetries'));
});

test('RecoveryEngine rolls back permanent failures using registered plans', async () => {
  const engine = new RecoveryEngine();
  const applied: string[] = [];
  const rollbackPlan: RollbackPlan = {
    checkpointId: 'cp-1',
    steps: [
      {
        id: 'step-a',
        apply: () => { applied.push('apply-a'); },
        rollback: () => { applied.push('rollback-a'); },
        verify: () => true,
      },
      {
        id: 'step-b',
        apply: () => { applied.push('apply-b'); },
        rollback: () => { applied.push('rollback-b'); },
        verify: () => true,
      },
    ],
    restoreState: () => { applied.push('restore-state'); },
    verifyRestoration: () => true,
  };
  engine.registerRollbackPlan(rollbackPlan);

  const result = await engine.attemptRecovery({
    sessionId: 'session-1',
    taskId: 'task-1',
    currentState: 'reviewing',
    lastCheckpointId: 'cp-1',
    failure: {
      category: 'permanent',
      error: new PermanentRecoveryError('bad patch'),
      reason: 'bad patch',
      timestamp: Date.now(),
      retryable: false,
    },
    attemptHistory: [],
    remainingRetries: 0,
  });

  assert.equal(result.action, 'rollback');
  assert.equal(result.success, true);
  assert.deepEqual(applied, ['rollback-b', 'rollback-a', 'restore-state']);
  assert.equal(result.rollbackResult?.verificationPassed, true);
});

test('RecoveryEngine escalates when no checkpoint exists', async () => {
  const engine = new RecoveryEngine();
  const result = await engine.attemptRecovery({
    sessionId: 'session-2',
    taskId: 'task-2',
    currentState: 'executing',
    failure: {
      category: 'permanent',
      error: new PermanentRecoveryError('unrecoverable'),
      reason: 'unrecoverable',
      timestamp: Date.now(),
      retryable: false,
    },
    attemptHistory: [],
    remainingRetries: 0,
  });

  assert.equal(result.action, 'escalate');
  assert.equal(result.newState, 'error');
  assert.equal(result.escalation?.targetModel, 'deepseek-reasoner');
});

test('RecoveryEngine halts on repeated loop signature', async () => {
  const engine = new RecoveryEngine();
  const makeContext = () => ({
    sessionId: 'session-loop',
    taskId: 'task-loop-2',
    currentState: 'executing',
    failure: {
      category: 'unknown' as const,
      error: new Error('same failure'),
      reason: 'same failure',
      timestamp: Date.now(),
      retryable: true,
    },
    attemptHistory: [{ attemptNumber: 1, timestamp: Date.now(), delayMs: 0 }],
    remainingRetries: 1,
  });

  const first = await engine.attemptRecovery(makeContext());
  const second = await engine.attemptRecovery(makeContext());
  const third = await engine.attemptRecovery(makeContext());

  assert.equal(first.action, 'retry');
  assert.equal(second.action, 'retry');
  assert.equal(third.action, 'halt');
  assert.ok((third.alerts ?? []).some((alert) => alert.code === 'RETRY_LOOP_DETECTED'));
});

test('RecoveryMonitor tracks success rate and failure analysis', () => {
  const monitor = new RecoveryMonitor();
  monitor.recordOperation(true, 1);
  monitor.recordOperation(false, 3);
  monitor.recordFailure('transient');
  monitor.recordFailure('transient');
  monitor.recordFailure('permanent');
  monitor.recordFallback();
  monitor.recordRecovered();
  monitor.recordRollback(true);
  monitor.alert('high', 'TEST_ALERT', 'test alert');

  const metrics = monitor.getMetrics();
  assert.equal(metrics.totalOperations, 2);
  assert.equal(metrics.successRate, 0.5);
  assert.equal(metrics.rollbackSuccesses, 1);
  assert.equal(monitor.analyzeFailures()[0]?.category, 'transient');
});

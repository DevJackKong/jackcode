import test from 'node:test';
import assert from 'node:assert/strict';

import { GPT54VerifierRepairer } from './repairer.js';
import { RetryManager, RecoveryEngine } from './recovery.js';
import type { ReviewContext } from '../types/reviewer.js';
import type { Patch } from '../types/patch.js';

function patch(targetPath: string): Patch {
  return {
    id: `patch-${targetPath.replace(/[^a-z0-9]/gi, '-')}`,
    targetPath,
    originalChecksum: 'checksum',
    reversePatch: { storagePath: `rollback/${targetPath}.patch`, checksum: 'checksum' },
    hunks: [
      {
        oldRange: { start: 1, end: 1 },
        newRange: { start: 1, end: 3 },
        contextBefore: [],
        removedLines: [],
        addedLines: ['export const value = 1;'],
        contextAfter: [],
      },
    ],
  };
}

function context(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return {
    taskId: 'task-11',
    intent: 'add validation and tests for runtime repair flow',
    changes: [
      {
        path: 'src/core/repairer.ts',
        changeType: 'modified',
        originalContent: 'export const value = 0;\n',
        newContent: 'export const value = 1;\n',
        patch: patch('src/core/repairer.ts'),
      },
      {
        path: 'src/core/repairer.test.ts',
        changeType: 'added',
        newContent: "import test from 'node:test';\n",
        patch: patch('src/core/repairer.test.ts'),
      },
    ],
    testResults: [
      {
        testId: 'repairer-test',
        filePath: 'src/core/repairer.test.ts',
        passed: true,
        durationMs: 12,
      },
    ],
    artifacts: [],
    attemptHistory: [],
    ...overrides,
  };
}

test('GPT54VerifierRepairer approves healthy changes', async () => {
  const verifier = new GPT54VerifierRepairer();
  const result = await verifier.verify(context());

  assert.equal(result.decision, 'approve');
  assert.equal(result.issues.length, 0);
  assert.ok(result.confidence > 0.7);
  assert.equal(verifier.getVerificationHistory('task-11')?.decision, 'approve');
});

test('GPT54VerifierRepairer rejects security issues', async () => {
  const verifier = new GPT54VerifierRepairer();
  const result = await verifier.verify(context({
    changes: [
      {
        path: 'src/unsafe.ts',
        changeType: 'modified',
        originalContent: 'export const run = () => 1;\n',
        newContent: "export const run = (input: string) => eval(input);\nconst token = 'abc123';\n",
        patch: patch('src/unsafe.ts'),
      },
    ],
    testResults: [],
  }));

  assert.equal(result.decision, 'reject');
  assert.ok(result.issues.some((issue) => issue.dimension === 'security'));
});

test('GPT54VerifierRepairer returns repair when tests are missing', async () => {
  const verifier = new GPT54VerifierRepairer();
  const result = await verifier.verify(context({
    changes: [
      {
        path: 'src/core/new-feature.ts',
        changeType: 'added',
        newContent: 'export function run() {\n  return 42;\n}\n',
        patch: patch('src/core/new-feature.ts'),
      },
    ],
    testResults: [],
  }));

  assert.equal(result.decision, 'repair');
  assert.ok(result.issues.some((issue) => issue.dimension === 'test_coverage'));
  assert.ok(result.repairs.length >= 1);
});

test('GPT54VerifierRepairer parses model output and factors it into verification', async () => {
  const verifier = new GPT54VerifierRepairer({}, {
    async verify() {
      return JSON.stringify({
        confidence: 0.2,
        summary: 'Model found a quality concern.',
        intentFulfilled: true,
        qualityScore: 0.6,
        issues: [
          {
            dimension: 'code_quality',
            severity: 'medium',
            description: 'Model flagged maintainability risk.',
            suggestion: 'Refactor the helper into a smaller unit.',
            location: { filePath: 'src/core/repairer.ts', lineStart: 1 },
          },
        ],
      });
    },
  });

  const result = await verifier.verify(context());
  assert.equal(result.decision, 'repair');
  assert.equal(result.report.summary, 'Model found a quality concern.');
  assert.ok(result.issues.some((issue) => issue.description.includes('maintainability risk')));
});

test('RetryManager classifies retryable failures', () => {
  const manager = new RetryManager({ jitter: false, baseDelayMs: 10, maxDelayMs: 100, backoffMultiplier: 2, maxRetries: 2, retryableErrors: ['ETIMEDOUT'] });
  const classified = manager.classifyError(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }));
  assert.equal(classified.category, 'transient');
  assert.equal(manager.calculateDelay(2), 20);
});

test('RecoveryEngine escalates permanent failure without checkpoint', async () => {
  const engine = new RecoveryEngine();
  const result = await engine.attemptRecovery({
    sessionId: 'session-1',
    taskId: 'task-1',
    currentState: 'reviewing',
    failure: {
      category: 'permanent',
      error: new Error('bad patch'),
      reason: 'bad patch',
      timestamp: Date.now(),
      retryable: false,
    },
    attemptHistory: [],
    remainingRetries: 0,
  });

  assert.equal(result.action, 'escalate');
  assert.equal(result.newState, 'error');
});

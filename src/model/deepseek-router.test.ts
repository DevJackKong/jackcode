import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DeepSeekReasonerRouter,
  type DeepSeekStreamChunk,
  type DeepSeekToolDefinition,
  type DeepSeekTransport,
} from './deepseek-router.ts';
import { ModelPolicyEngine } from './policy.ts';
import type { RepairContext } from './types/reasoning.ts';
import type { CompressedContext } from '../types/context.ts';

function compressedContext(content: string, tokens = Math.ceil(content.length / 4)): CompressedContext {
  return {
    content,
    fragments: [],
    stats: {
      originalTokens: tokens,
      finalTokens: tokens,
      savedTokens: 0,
      ratio: 1,
      fragmentsDropped: 0,
      fragmentsSummarized: 0,
    },
    strategy: {
      level: 0,
      targetBudget: tokens,
      preserveTypes: [],
      preserveTags: [],
      minPriority: 0,
    },
    compressedAt: Date.now(),
  };
}

function repairContext(overrides: Partial<RepairContext> = {}): RepairContext {
  const context = overrides.context ?? compressedContext('src/app.ts throws TypeError: cannot read property of undefined', 8000);
  return {
    taskId: overrides.taskId ?? 'task-1',
    intent: overrides.intent ?? 'Fix runtime bug in app startup',
    attemptNumber: overrides.attemptNumber ?? 2,
    maxAttempts: overrides.maxAttempts ?? 3,
    context,
    errors: overrides.errors ?? [
      {
        timestamp: Date.now(),
        state: 'executing',
        message: 'TypeError: cannot read properties of undefined at src/app.ts:12',
        recoverable: true,
        classification: 'transient',
      },
    ],
    artifacts: overrides.artifacts ?? [
      {
        id: 'a1',
        type: 'file',
        path: 'src/app.ts',
      },
    ],
  };
}

test('selectRoute chooses deepseek-reasoner for repeated runtime failures', () => {
  const router = new DeepSeekReasonerRouter();
  const route = router.selectRoute(repairContext());

  assert.equal(route.selectedModel, 'deepseek-reasoner');
  assert.equal(route.useReasoning, true);
  assert.ok(route.rationale.some((line) => line.includes('Escalation enabled')));
});

test('selectRoute can choose deepseek-chat for first simple syntax failure', () => {
  const router = new DeepSeekReasonerRouter(
    { model: 'deepseek-reasoner' },
    { preferredQualityBias: 0.4 }
  );
  const route = router.selectRoute(
    repairContext({
      attemptNumber: 1,
      errors: [
        {
          timestamp: Date.now(),
          state: 'executing',
          message: 'SyntaxError: unexpected token in src/foo.ts:8',
          recoverable: true,
          classification: 'validation',
        },
      ],
      artifacts: [{ id: 'a2', type: 'file', path: 'src/foo.ts' }],
      context: compressedContext('syntax issue in src/foo.ts', 1200),
    })
  );

  assert.equal(route.selectedModel, 'deepseek-chat');
  assert.equal(route.useReasoning, false);
});

test('assessEscalation detects dependency and repeated-failure triggers', () => {
  const router = new DeepSeekReasonerRouter();
  const dependencyEscalation = router.assessEscalation(
    repairContext({
      attemptNumber: 1,
      errors: [
        {
          timestamp: Date.now(),
          state: 'executing',
          message: 'Cannot find module ../shared/util from src/feature.ts',
          recoverable: true,
          classification: 'validation',
        },
      ],
    })
  );
  assert.equal(dependencyEscalation.trigger, 'dependency_error');
  assert.equal(dependencyEscalation.shouldEscalate, true);

  const repeatedEscalation = router.assessEscalation(
    repairContext({
      attemptNumber: 3,
      errors: [
        {
          timestamp: Date.now(),
          state: 'executing',
          message: 'Unknown failure one',
          recoverable: true,
          classification: 'unknown',
        },
        {
          timestamp: Date.now(),
          state: 'executing',
          message: 'Unknown failure two',
          recoverable: true,
          classification: 'unknown',
        },
      ],
    })
  );
  assert.equal(repeatedEscalation.trigger, 'repeated_failures');
});

test('formatPrompt includes escalation details, artifacts, and compressed context', () => {
  const router = new DeepSeekReasonerRouter();
  const context = repairContext();
  const route = router.selectRoute(context);
  const escalation = router.assessEscalation(context);
  const prompt = router.formatPrompt(context, route, escalation);

  assert.equal(prompt[0].role, 'system');
  assert.equal(prompt[1].role, 'user');
  assert.match(prompt[1].content, /Escalation Trigger/);
  assert.match(prompt[1].content, /Artifacts:/);
  assert.match(prompt[1].content, /Compressed Context:/);
  assert.match(prompt[1].content, /src\/app.ts/);
});

test('extractReasoningChain prefers reasoning field and strips bullet formatting', () => {
  const router = new DeepSeekReasonerRouter();
  const chain = router.extractReasoningChain({
    reasoning: '- Inspect failure\n2. Compare imports\n* Validate fix',
    content: 'ignored',
  });

  assert.deepEqual(chain, ['Inspect failure', 'Compare imports', 'Validate fix']);
});

test('executeRequest handles retries after rate limit and returns usage + tool calls', async () => {
  let calls = 0;
  const transport: DeepSeekTransport = {
    async complete() {
      calls += 1;
      if (calls === 1) {
        throw new Error('429 rate limit retry-after=25');
      }
      return {
        content: 'ROOT_CAUSE: test expectation drift\nREPAIR_PLAN: align output\nCONFIDENCE: 0.77',
        reasoning: 'Inspect failing assertion\nCompare expected and actual',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'read_file',
            arguments: { path: 'src/app.ts' },
          },
        ],
      };
    },
  };

  const router = new DeepSeekReasonerRouter({}, { transport, retryBaseDelayMs: 1, maxBackoffMs: 1 });
  const context = repairContext();
  const route = router.selectRoute(context);
  const tools: DeepSeekToolDefinition[] = [
    { name: 'read_file', description: 'Read file content' },
  ];

  const result = await router.executeRequest(router.formatPrompt(context, route), route, {
    tools,
    allowFallback: true,
  });

  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.toolCalls.length, 1);
  assert.ok(result.usage.totalTokens > 0);
  assert.equal(result.fallbackUsed, false);
});

test('executeRequest consumes streaming transport responses', async () => {
  async function* stream(): AsyncIterable<DeepSeekStreamChunk> {
    yield { type: 'reasoning', delta: 'Inspect stack\n' };
    yield { type: 'content', delta: 'ROOT_CAUSE: null path\n' };
    yield {
      type: 'tool_call',
      toolCall: { id: 'tool-2', name: 'grep', arguments: { pattern: 'null' } },
    };
    yield { type: 'done' };
  }

  const transport: DeepSeekTransport = {
    async complete() {
      return { content: 'unused' };
    },
    stream,
  };

  const router = new DeepSeekReasonerRouter({}, { transport });
  const context = repairContext();
  const route = router.selectRoute(context);
  const result = await router.executeRequest(router.formatPrompt(context, route), route, {
    stream: true,
  });

  assert.match(result.raw.content, /ROOT_CAUSE/);
  assert.equal(result.toolCalls[0]?.name, 'grep');
  assert.ok(result.reasoningChain.includes('Inspect stack'));
});

test('executeRequest falls back when transport repeatedly fails', async () => {
  const transport: DeepSeekTransport = {
    async complete() {
      throw new Error('503 server error');
    },
  };

  const router = new DeepSeekReasonerRouter({}, { transport, maxRetries: 2, retryBaseDelayMs: 1, maxBackoffMs: 1 });
  const context = repairContext();
  const route = router.selectRoute(context);
  const result = await router.executeRequest(router.formatPrompt(context, route), route, {
    allowFallback: true,
  });

  assert.equal(result.fallbackUsed, true);
  assert.equal(result.error?.type, 'server');
  assert.match(result.raw.content, /Fallback/);
});

test('analyzeFailure integrates policy, routing, execution, and repair strategy', async () => {
  const transport: DeepSeekTransport = {
    async complete() {
      return {
        content: [
          'ROOT_CAUSE: import path mismatch between feature and shared module',
          'REASONING: compare export surface before editing consumers',
          'REPAIR_PLAN: fix import path and rerun focused test',
          'RISKS: cascading_failure',
          'CONFIDENCE: 0.81',
        ].join('\n'),
        reasoning: 'Classify dependency failure\nCheck nearest changed import\nValidate export surface',
      };
    },
  };

  const policy = new ModelPolicyEngine();
  const router = new DeepSeekReasonerRouter({}, { transport, policy });
  const result = await router.analyzeFailure(
    repairContext({
      attemptNumber: 2,
      errors: [
        {
          timestamp: Date.now(),
          state: 'executing',
          message: 'Cannot find module ./shared/index from src/feature.ts',
          recoverable: true,
          classification: 'validation',
        },
      ],
      artifacts: [{ id: 'f1', type: 'file', path: 'src/feature.ts' }],
      intent: 'Repair broken import after refactor',
    })
  );

  assert.match(result.rootCause, /import path mismatch/i);
  assert.ok(result.reasoningChain.some((line) => /Validate export surface/i.test(line)));
  assert.ok(result.strategy.plan.steps.some((step) => step.action === 'verify_dependency_graph'));
  assert.equal(router.getConfidenceLevel(result.confidence), 'medium');
});

test('coordinateWithQwen indicates whether to retry qwen or perform deepseek analysis', () => {
  const router = new DeepSeekReasonerRouter();
  const escalated = router.coordinateWithQwen(repairContext({ attemptNumber: 2 }));
  assert.equal(escalated.deepseekShouldAnalyze, true);
  assert.equal(escalated.qwenShouldRetry, false);

  const firstTry = router.coordinateWithQwen(
    repairContext({
      attemptNumber: 1,
      errors: [
        {
          timestamp: Date.now(),
          state: 'executing',
          message: 'SyntaxError: missing ) in src/foo.ts:9',
          recoverable: true,
          classification: 'validation',
        },
      ],
      context: compressedContext('simple syntax failure', 1000),
    })
  );
  assert.equal(firstTry.qwenShouldRetry, true);
  assert.equal(firstTry.deepseekShouldAnalyze, false);
});

test('classifyError maps retryable and terminal DeepSeek failures', () => {
  const router = new DeepSeekReasonerRouter();

  assert.deepEqual(router.classifyError(new Error('429 rate limit retry-after=99')), {
    type: 'rate_limit',
    retryable: true,
    message: '429 rate limit retry-after=99',
    retryAfterMs: 99,
  });

  const contextOverflow = router.classifyError(new Error('maximum context length exceeded'));
  assert.equal(contextOverflow.type, 'context_overflow');
  assert.equal(contextOverflow.retryable, false);
});

test('createRepairContextFromRuntimeTask converts runtime task state for integration', () => {
  const router = new DeepSeekReasonerRouter();
  const ctx = compressedContext('runtime compressed context', 1500);
  const repair = router.createRepairContextFromRuntimeTask(
    {
      id: 'runtime-1',
      sessionId: 'session-1',
      state: 'error',
      status: 'failed',
      intent: 'Fix broken build',
      priority: 'high',
      routePriority: 'critical',
      attempts: 2,
      maxAttempts: 3,
      artifacts: [{ id: 'art-1', type: 'patch', path: 'src/build.ts' }],
      errors: [
        {
          timestamp: Date.now(),
          state: 'executing',
          message: 'TypeError in src/build.ts',
          recoverable: true,
          classification: 'transient',
        },
      ],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      retryCount: 1,
      metadata: {},
      plan: {
        steps: [],
        estimatedTokens: 1500,
        targetModel: 'qwen',
      },
    },
    ctx
  );

  assert.equal(repair.taskId, 'runtime-1');
  assert.equal(repair.attemptNumber, 2);
  assert.equal(repair.context?.stats.finalTokens, 1500);
});

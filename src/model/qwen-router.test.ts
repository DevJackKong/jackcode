import test from 'node:test';
import assert from 'node:assert/strict';

import { createQwenRouter, type QwenPreparedRequest } from './qwen-router.ts';
import type { QwenRouteRequest } from './types.ts';
import type { CompressedContext } from '../types/context.ts';

function createContext(content: string, finalTokens = Math.ceil(content.length / 4)): CompressedContext {
  return {
    content,
    fragments: [],
    compressedAt: Date.now(),
    strategy: {
      level: 1,
      targetBudget: null,
      preserveTypes: ['code', 'error', 'system', 'symbol', 'doc'],
      preserveTags: [],
      minPriority: 0,
    },
    stats: {
      originalTokens: finalTokens,
      finalTokens,
      savedTokens: 0,
      ratio: 1,
      fragmentsDropped: 0,
      fragmentsSummarized: 0,
    },
  };
}

function createRequest(overrides: Partial<QwenRouteRequest & {
  systemPrompt?: string;
  userPrompt?: string;
  stream?: boolean;
  tools?: Array<{ name: string; description: string }>;
  maxOutputTokens?: number;
  onStreamChunk?: (chunk: string) => void;
}> = {}): QwenRouteRequest {
  return {
    taskId: overrides.taskId ?? 'task-1',
    context: overrides.context ?? createContext('const answer = 42;'),
    operations: overrides.operations ?? [
      {
        id: 'op-1',
        type: 'edit',
        targetFile: 'src/index.ts',
        description: 'Apply change',
        dependencies: [],
      },
    ],
    priority: overrides.priority ?? 'normal',
    timeoutMs: overrides.timeoutMs ?? 1_000,
    ...(overrides as object),
  } as QwenRouteRequest;
}

test('selects qwen-coder for code-editing requests with tools', () => {
  const router = createQwenRouter();
  const prepared = router.prepareRequest(
    createRequest({
      tools: [{ name: 'apply_patch', description: 'Apply a patch' }],
    }) as never
  );

  assert.equal(prepared.model, 'qwen-coder');
  assert.equal(prepared.tools.length, 1);
  assert.equal(prepared.messages[0]?.role, 'system');
  assert.equal(prepared.messages[1]?.role, 'user');
});

test('uses fast model for small cheap requests when allowed by policy', () => {
  const router = createQwenRouter({}, {
    policy: {
      selectModel: () => ({
        taskId: 'task-1',
        selectedModel: 'qwen',
        reasoning: 'cheap path',
        estimatedCost: 0.001,
        estimatedTokens: 100,
        fallbackOnFailure: true,
      }),
      checkBudget: () => ({ allowed: true, reason: 'within_budget' }),
    },
  });

  const prepared = router.prepareRequest(createRequest({
    operations: [{
      id: 'op-1',
      type: 'create',
      targetFile: 'README.md',
      description: 'small update',
      dependencies: [],
    }],
    context: createContext('tiny context', 200),
  }) as never);

  assert.equal(prepared.model, 'qwen-3.6-fast');
});

test('optimizes large contexts to fit model budget', () => {
  const router = createQwenRouter();
  const hugeContext = 'a'.repeat(600_000);
  const prepared = router.prepareRequest(createRequest({
    context: createContext(hugeContext, 150_000),
    maxOutputTokens: 1024,
  }) as never);

  assert.match(prepared.messages[1]?.content ?? '', /trimmed for Qwen token budget/);
  assert.ok(prepared.inputTokens < 128_000);
});

test('supports streaming responses and forwards chunks', async () => {
  const chunks: string[] = [];
  let streamCalled = false;
  const router = createQwenRouter({}, {
    provider: {
      execute: async () => ({ content: 'unused', tokensUsed: 0 }),
      stream: async (_request: QwenPreparedRequest, onChunk: (chunk: string) => void) => {
        streamCalled = true;
        onChunk('hello ');
        onChunk('world');
        return {
          content: 'hello world',
          tokensUsed: 33,
          outputTokens: 2,
        };
      },
    },
  });

  const result = await router.route(createRequest({
    stream: true,
    onStreamChunk: (chunk) => chunks.push(chunk),
  }) as never);

  assert.equal(streamCalled, true);
  assert.deepEqual(chunks, ['hello ', 'world']);
  assert.equal(result.success, true);
  assert.equal(result.operations[0]?.diff, 'hello world');
});

test('retries rate limits and falls back to another qwen model', async () => {
  const attemptedModels: string[] = [];
  let callCount = 0;
  const router = createQwenRouter({ retryLimit: 2, retryBackoffMs: 1 }, {
    provider: {
      execute: async (request) => {
        attemptedModels.push(request.model);
        callCount += 1;
        if (callCount === 1) {
          throw new Error('429 rate limit exceeded');
        }
        return {
          content: `ok via ${request.model}`,
          tokensUsed: 20,
          outputTokens: 4,
        };
      },
    },
  });

  const result = await router.route(createRequest());

  assert.equal(result.success, true);
  assert.equal(callCount, 2);
  assert.deepEqual(attemptedModels, ['qwen-coder', 'qwen-3.6-fast']);
  assert.equal(result.operations[0]?.diff, 'ok via qwen-3.6-fast');
});

test('classifies context overflow and returns escalation', async () => {
  const router = createQwenRouter({}, {
    provider: {
      execute: async () => {
        throw new Error('maximum token context exceeded');
      },
    },
  });

  const result = await router.route(createRequest());

  assert.equal(result.success, false);
  assert.equal(result.escalation, 'context_overflow');
});

test('batches multi-operation requests and returns per-operation results', async () => {
  const seenTargets: string[] = [];
  const router = createQwenRouter({ maxConcurrency: 2, maxBatchSize: 5 }, {
    provider: {
      execute: async (request) => {
        const targetLine = request.messages[1]?.content.split('\n').find((line) => line.includes('src/')) ?? '';
        seenTargets.push(targetLine);
        return {
          content: 'batched-result',
          tokensUsed: 10,
          outputTokens: 2,
        };
      },
    },
  });

  const result = await router.route(createRequest({
    operations: [
      {
        id: 'op-1',
        type: 'edit',
        targetFile: 'src/a.ts',
        description: 'edit a',
        dependencies: [],
      },
      {
        id: 'op-2',
        type: 'edit',
        targetFile: 'src/b.ts',
        description: 'edit b',
        dependencies: [],
      },
      {
        id: 'op-3',
        type: 'refactor',
        targetFile: 'src/c.ts',
        description: 'edit c',
        dependencies: [],
      },
    ],
  }));

  assert.equal(result.success, true);
  assert.equal(result.operations.length, 3);
  assert.equal(seenTargets.length, 3);
  assert.ok(result.metrics.latencyMs >= 0);
});

test('returns cached result for identical requests', async () => {
  let executeCalls = 0;
  const router = createQwenRouter({ cacheTtlMs: 10_000 }, {
    provider: {
      execute: async () => {
        executeCalls += 1;
        return {
          content: 'cached result',
          tokensUsed: 12,
          outputTokens: 3,
        };
      },
    },
  });

  const request = createRequest();
  const first = await router.route(request);
  const second = await router.route(request);

  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(executeCalls, 1);
  assert.equal(second.operations[0]?.diff, 'cached result');
});

test('batchRoute preserves order while respecting concurrency', async () => {
  const router = createQwenRouter({ maxConcurrency: 2 }, {
    provider: {
      execute: async (request) => ({
        content: request.messages[1]?.content.split('\n')[0] ?? 'ok',
        tokensUsed: 5,
        outputTokens: 1,
      }),
    },
  });

  const results = await router.batchRoute([
    createRequest({ taskId: 'task-a' }),
    createRequest({ taskId: 'task-b' }),
    createRequest({ taskId: 'task-c' }),
  ]);

  assert.deepEqual(results.map((result) => result.taskId), ['task-a', 'task-b', 'task-c']);
  assert.ok(results.every((result) => result.success));
});

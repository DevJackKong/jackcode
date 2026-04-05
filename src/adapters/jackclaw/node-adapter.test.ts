import test from 'node:test';
import assert from 'node:assert/strict';

import {
  JackClawNodeAdapter,
  MessageRouter,
  NodeIdentityManager,
  RateLimiter,
  TaskReceiver,
  TaskRouter,
  type JackClawAdapterConfig,
  type JackClawMessage,
  type NodeTransport,
  type RuntimeAdapter,
} from './node-adapter.js';

class MockTransport implements NodeTransport {
  public sent: string[] = [];
  public connectCalls = 0;
  public closeCalls: Array<{ code?: number; reason?: string }> = [];

  private openHandlers: Array<() => void> = [];
  private closeHandlers: Array<(code?: number, reason?: string) => void> = [];
  private errorHandlers: Array<(error: Error) => void> = [];
  private messageHandlers: Array<(raw: string) => void> = [];

  onOpen(handler: () => void): void {
    this.openHandlers.push(handler);
  }

  onClose(handler: (code?: number, reason?: string) => void): void {
    this.closeHandlers.push(handler);
  }

  onError(handler: (error: Error) => void): void {
    this.errorHandlers.push(handler);
  }

  onMessage(handler: (raw: string) => void): void {
    this.messageHandlers.push(handler);
  }

  async connect(): Promise<void> {
    this.connectCalls += 1;
    for (const handler of this.openHandlers) {
      handler();
    }
  }

  async send(raw: string): Promise<void> {
    this.sent.push(raw);
  }

  async close(code?: number, reason?: string): Promise<void> {
    this.closeCalls.push({ code, reason });
    for (const handler of this.closeHandlers) {
      handler(code, reason);
    }
  }

  emitMessage(raw: string): void {
    for (const handler of this.messageHandlers) {
      handler(raw);
    }
  }

  emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }
}

function createConfig(overrides: Partial<JackClawAdapterConfig> = {}): JackClawAdapterConfig {
  return {
    hubUrl: 'http://hub.local',
    nodeId: 'node-1',
    nodeName: 'Node 1',
    port: 18080,
    autoRegister: false,
    reportCron: '0 8 * * *',
    authToken: 'secret-token',
    signingSecret: 'shared-secret',
    heartbeatIntervalMs: 5_000,
    heartbeatTimeoutMs: 20_000,
    reconnectIntervalMs: 10,
    maxReconnectIntervalMs: 20,
    requestTimeoutMs: 100,
    rateLimitPerMinute: 10,
    maxConcurrentTasks: 2,
    maxPayloadBytes: 10_000,
    ...overrides,
  };
}

test('NodeIdentityManager signs and verifies payloads deterministically', async () => {
  const identity = new NodeIdentityManager();
  await identity.loadOrCreate({ nodeId: 'node-a', signingSecret: 'secret-a' });

  const payload = { b: 2, a: 1 };
  const signature = identity.sign(payload, 'secret-a');

  assert.equal(identity.verify('node-a', { a: 1, b: 2 }, signature, 'secret-a'), true);
  assert.equal(identity.verify('node-a', { a: 1, b: 3 }, signature, 'secret-a'), false);
});

test('TaskReceiver sanitizes incoming tasks and dispatches them', async () => {
  const identity = new NodeIdentityManager();
  await identity.loadOrCreate({ nodeId: 'hub', signingSecret: 'shared-secret' });
  const receiver = new TaskReceiver(identity);
  receiver.start(8080);

  receiver.onTask(async (task) => {
    assert.equal(task.taskId, 'task-1');
    assert.equal(task.action, 'run test');
    assert.deepEqual(task.params, {
      files: ['src/index.ts', 'x'],
      nested: { ok: 'fine' },
    });
    assert.equal(Object.prototype.hasOwnProperty.call(task.params, '__proto__'), false);
    return {
      taskId: task.taskId,
      status: 'success',
      durationMs: 1,
      attempts: 1,
    };
  });

  const payload = {
    taskId: 'task-1',
    action: 'run\u0000test',
    params: {
      files: ['src/index.ts', { weird: true }, 'x'],
      nested: { ok: 'fine' },
      __proto__: { polluted: true },
    },
  };
  const message: JackClawMessage = {
    id: 'm1',
    from: 'hub',
    to: 'node-1',
    type: 'task',
    payload,
    timestamp: Date.now(),
    signature: identity.sign(payload, 'shared-secret'),
  };

  const result = await receiver.handleIncomingTask(message, 'shared-secret');
  assert.equal(result.status, 'success');
});

test('TaskRouter reports progress and returns artifacts from runtime adapter', async () => {
  const progressStates: string[] = [];
  const runtimeAdapter: RuntimeAdapter = {
    createTask: () => ({ id: 'rt-1' }),
    setPlan: () => undefined,
    runTask: async () => ({
      attempts: 2,
      artifacts: [{ id: 'a1', type: 'log', path: 'runtime/task.log', content: 'done' }],
      errors: [],
    }),
  };
  const router = new TaskRouter(runtimeAdapter);

  const result = await router.route(
    {
      taskId: 'task-1',
      action: 'fix lint',
      params: { files: ['src/a.ts'] },
      priority: 'high',
    },
    async (progress) => {
      progressStates.push(progress.state);
    }
  );

  assert.equal(result.status, 'success');
  assert.equal(result.attempts, 2);
  assert.deepEqual(progressStates, ['plan', 'execute', 'review', 'done']);
  assert.equal(result.artifacts?.[0]?.path, 'runtime/task.log');
});

test('MessageRouter serializes/deserializes and request correlation resolves replies', async () => {
  const transport = new MockTransport();
  const adapter = new JackClawNodeAdapter(createConfig(), {
    transportFactory: () => transport,
    runtimeAdapter: {
      createTask: () => ({ id: 'task-1' }),
      setPlan: () => undefined,
      runTask: async () => ({ attempts: 1, artifacts: [], errors: [] }),
    },
  });

  await adapter.identity.loadOrCreate({ nodeId: 'node-1', signingSecret: 'shared-secret' });
  const replyPromise = adapter.sendRequest('ping', { hello: 'world' }, { awaitReply: true });
  const sent = JSON.parse(transport.sent[0]!) as JackClawMessage;

  const replyPayload = { ok: true };
  const reply: JackClawMessage = {
    id: 'reply-1',
    from: 'hub',
    to: 'node-1',
    type: 'pong',
    payload: replyPayload,
    timestamp: Date.now(),
    signature: adapter.identity.sign(replyPayload, 'shared-secret'),
    replyTo: sent.id,
  };

  await adapter.handleRawMessage(new MessageRouter().serialize(reply));
  const resolved = await replyPromise;
  assert.ok(resolved);
  assert.equal(resolved.type, 'pong');
  assert.deepEqual(resolved.payload, { ok: true });
});

test('adapter authenticates on connect, handles heartbeats, broadcasts, and health requests', async () => {
  const transport = new MockTransport();
  const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
  const adapter = new JackClawNodeAdapter(createConfig(), {
    transportFactory: () => transport,
    fetchImpl: async (url, init) => {
      fetchCalls.push({ url: String(url), init });
      return new Response('{}', { status: 200 });
    },
    runtimeAdapter: {
      createTask: () => ({ id: 'task-1' }),
      setPlan: () => undefined,
      runTask: async () => ({ attempts: 1, artifacts: [], errors: [] }),
    },
  });

  const broadcasts: unknown[] = [];
  adapter.on('broadcast', (payload) => broadcasts.push(payload));

  await adapter.start();
  assert.equal(transport.connectCalls, 1);
  assert.equal(fetchCalls.length, 0);

  const authEnvelope = JSON.parse(transport.sent[0]!) as JackClawMessage;
  assert.equal(authEnvelope.type, 'auth');

  const authOkPayload = { ok: true };
  await adapter.handleRawMessage(JSON.stringify({
    id: 'auth-ok',
    from: 'hub',
    to: 'node-1',
    type: 'auth_ok',
    payload: authOkPayload,
    timestamp: Date.now(),
    signature: adapter.identity.sign(authOkPayload, 'shared-secret'),
  } satisfies JackClawMessage));

  const broadcastPayload = { announcement: 'hello nodes' };
  await adapter.handleRawMessage(JSON.stringify({
    id: 'broadcast-1',
    from: 'hub',
    to: 'all',
    type: 'broadcast',
    payload: broadcastPayload,
    timestamp: Date.now(),
    signature: adapter.identity.sign(broadcastPayload, 'shared-secret'),
  } satisfies JackClawMessage));
  assert.deepEqual(broadcasts, [broadcastPayload]);

  const healthPayload = { request: true };
  await adapter.handleRawMessage(JSON.stringify({
    id: 'health-1',
    from: 'hub',
    to: 'node-1',
    type: 'health',
    payload: healthPayload,
    timestamp: Date.now(),
    signature: adapter.identity.sign(healthPayload, 'shared-secret'),
  } satisfies JackClawMessage));

  const healthReply = JSON.parse(transport.sent.at(-1)!) as JackClawMessage;
  assert.equal(healthReply.type, 'health_response');
  assert.equal((healthReply.payload as { nodeId: string }).nodeId, 'node-1');

  const pingPayload = { t: 1 };
  await adapter.handleRawMessage(JSON.stringify({
    id: 'ping-1',
    from: 'hub',
    to: 'node-1',
    type: 'ping',
    payload: pingPayload,
    timestamp: Date.now(),
    signature: adapter.identity.sign(pingPayload, 'shared-secret'),
  } satisfies JackClawMessage));

  const pongReply = JSON.parse(transport.sent.at(-1)!) as JackClawMessage;
  assert.equal(pongReply.type, 'pong');

  await adapter.stop();
  assert.equal(transport.closeCalls.at(-1)?.reason, 'graceful shutdown');
});

test('adapter executes inbound tasks, sends progress/completion reports, and exposes health/load', async () => {
  const transport = new MockTransport();
  const reports: JackClawMessage[] = [];
  const adapter = new JackClawNodeAdapter(createConfig({ maxConcurrentTasks: 1 }), {
    transportFactory: () => transport,
    fetchImpl: async (_url, init) => {
      reports.push(JSON.parse(String(init?.body)) as JackClawMessage);
      return new Response('{}', { status: 200 });
    },
    runtimeAdapter: {
      createTask: () => ({ id: 'task-1' }),
      setPlan: () => undefined,
      runTask: async () => ({
        attempts: 1,
        artifacts: [{ id: 'artifact-1', type: 'log', path: 'runtime/task-1.log', content: 'ok' }],
        errors: [],
      }),
    },
  });

  await adapter.start();

  const taskPayload = {
    taskId: 'task-1',
    action: 'run tests',
    params: { files: ['src/test.ts'] },
    priority: 'normal',
  };
  await adapter.handleRawMessage(JSON.stringify({
    id: 'task-msg-1',
    from: 'hub',
    to: 'node-1',
    type: 'task',
    payload: taskPayload,
    timestamp: Date.now(),
    signature: adapter.identity.sign(taskPayload, 'shared-secret'),
  } satisfies JackClawMessage));

  assert.ok(reports.length >= 2);
  assert.equal(reports.some((msg) => (msg.payload as { type?: string }).type === 'progress'), true);
  assert.equal(reports.some((msg) => (msg.payload as { type?: string }).type === 'completion'), true);

  const health = adapter.getHealthSnapshot();
  assert.equal(health.nodeId, 'node-1');
  assert.equal(health.loadScore >= 0 && health.loadScore <= 1, true);

  await adapter.stop();
});

test('RateLimiter blocks bursts above configured limit', () => {
  let current = 0;
  const limiter = new RateLimiter(2, () => current);

  assert.equal(limiter.consume(), true);
  current += 10;
  assert.equal(limiter.consume(), true);
  current += 10;
  assert.equal(limiter.consume(), false);
  current += 60_000;
  assert.equal(limiter.consume(), true);
});

test('adapter rejects invalid signatures and oversized payloads', async () => {
  const transport = new MockTransport();
  const adapter = new JackClawNodeAdapter(createConfig({ maxPayloadBytes: 20_000 }), {
    transportFactory: () => transport,
    runtimeAdapter: {
      createTask: () => ({ id: 'task-1' }),
      setPlan: () => undefined,
      runTask: async () => ({ attempts: 1, artifacts: [], errors: [] }),
    },
  });
  await adapter.identity.loadOrCreate({ nodeId: 'node-1', signingSecret: 'shared-secret' });

  await assert.rejects(
    adapter.handleRawMessage('x'.repeat(25_000)),
    /Payload too large/
  );

  const payload = { x: 1 };
  await assert.rejects(
    adapter.handleRawMessage(JSON.stringify({
      id: 'bad-1',
      from: 'hub',
      to: 'node-1',
      type: 'ping',
      payload,
      timestamp: Date.now(),
      signature: 'invalid',
    } satisfies JackClawMessage)),
    /Invalid message signature/
  );
});

/**
 * Thread 13: JackClaw Node Adapter
 * Bridges JackCode with JackClaw Node ecosystem
 */

import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import process from 'node:process';

import { runtime, type Artifact, type ExecutionPlan } from '../../core/runtime.js';

export type JackClawMessageType =
  | 'auth'
  | 'auth_ok'
  | 'auth_error'
  | 'task'
  | 'report'
  | 'ack'
  | 'ping'
  | 'pong'
  | 'health'
  | 'health_response'
  | 'broadcast'
  | 'shutdown';

export interface JackClawMessage<TPayload = unknown> {
  id: string;
  from: string;
  to: string;
  type: JackClawMessageType;
  payload: TPayload;
  timestamp: number;
  signature: string;
  correlationId?: string;
  replyTo?: string;
  broadcast?: boolean;
}

export interface JackClawTask {
  taskId: string;
  action: string;
  params: Record<string, unknown>;
  deadline?: number;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  requireApproval?: boolean;
  timeoutMs?: number;
}

export interface TaskResult {
  taskId: string;
  status: 'success' | 'failure' | 'cancelled';
  output?: string;
  artifacts?: Array<{
    type: string;
    path: string;
    content?: string;
  }>;
  error?: string;
  durationMs: number;
  attempts: number;
}

export interface ProgressUpdate {
  taskId: string;
  state: 'plan' | 'execute' | 'repair' | 'review' | 'done' | 'error';
  message: string;
  percentComplete?: number;
  timestamp: number;
}

export interface DailyReport {
  period: string;
  tasksCompleted: number;
  tasksFailed: number;
  totalDurationMs: number;
  tokenUsage: {
    qwen: number;
    gpt54: number;
  };
}

export interface ResourceUsage {
  memoryRss: number;
  heapUsed: number;
  heapTotal: number;
  uptimeSeconds: number;
  cpuUserMicros: number;
  cpuSystemMicros: number;
}

export interface HealthSnapshot {
  nodeId: string;
  connected: boolean;
  authenticated: boolean;
  inflightRequests: number;
  activeTasks: number;
  queuedTasks: number;
  loadScore: number;
  resourceUsage: ResourceUsage;
  timestamp: number;
}

export interface NodeIdentity {
  nodeId: string;
  publicKey: string;
  privateKey: string;
  sharedSecret: string;
  displayName?: string;
  role?: string;
  createdAt: number;
}

export interface JackClawAdapterConfig {
  hubUrl: string;
  nodeId?: string;
  nodeName?: string;
  port: number;
  autoRegister: boolean;
  reportCron: string;
  authToken?: string;
  signingSecret?: string;
  reconnectIntervalMs?: number;
  maxReconnectIntervalMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatTimeoutMs?: number;
  requestTimeoutMs?: number;
  rateLimitPerMinute?: number;
  maxConcurrentTasks?: number;
  maxPayloadBytes?: number;
}

interface RegisterPayload {
  nodeId: string;
  nodeName: string;
  port: number;
  role: string;
  publicKey: string;
  capabilities: string[];
  loadScore: number;
}

export interface NodeTransport {
  onOpen(handler: () => void): void;
  onClose(handler: (code?: number, reason?: string) => void): void;
  onError(handler: (error: Error) => void): void;
  onMessage(handler: (raw: string) => void): void;
  connect(): Promise<void>;
  send(raw: string): Promise<void>;
  close(code?: number, reason?: string): Promise<void>;
}

export interface RuntimeAdapter {
  createTask(intent: string, options?: { id?: string; priority?: JackClawTask['priority']; timeoutMs?: number }): { id: string };
  setPlan(id: string, plan: ExecutionPlan): unknown;
  runTask(id: string): Promise<{
    attempts: number;
    artifacts: Artifact[];
    errors: Array<{ message: string }>;
  }>;
}

interface PendingRequest {
  resolve: (message: JackClawMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export interface NodeAdapterDependencies {
  fetchImpl?: typeof fetch;
  transportFactory?: (config: JackClawAdapterConfig) => NodeTransport;
  runtimeAdapter?: RuntimeAdapter;
  now?: () => number;
}

const DEFAULT_CONFIG: Required<Pick<JackClawAdapterConfig,
  'autoRegister'
  | 'reportCron'
  | 'reconnectIntervalMs'
  | 'maxReconnectIntervalMs'
  | 'heartbeatIntervalMs'
  | 'heartbeatTimeoutMs'
  | 'requestTimeoutMs'
  | 'rateLimitPerMinute'
  | 'maxConcurrentTasks'
  | 'maxPayloadBytes'>> = {
  autoRegister: true,
  reportCron: '0 8 * * *',
  reconnectIntervalMs: 1_000,
  maxReconnectIntervalMs: 30_000,
  heartbeatIntervalMs: 15_000,
  heartbeatTimeoutMs: 45_000,
  requestTimeoutMs: 10_000,
  rateLimitPerMinute: 120,
  maxConcurrentTasks: 2,
  maxPayloadBytes: 256 * 1024,
};

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}

function sanitizeString(input: string, maxLength = 4_000): string {
  return input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function sanitizeRecord(input: unknown, depth = 0): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 6) {
    return {};
  }

  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === 'string') {
      output[key] = sanitizeString(value, 2_000);
      continue;
    }
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[key] = value;
      continue;
    }
    if (Array.isArray(value)) {
      output[key] = value
        .slice(0, 50)
        .flatMap((entry) => {
          if (typeof entry === 'string') return [sanitizeString(entry, 500)];
          if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) return [entry];
          return [];
        });
      continue;
    }
    if (typeof value === 'object') {
      output[key] = sanitizeRecord(value, depth + 1);
    }
  }
  return output;
}

function sha256(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

class DefaultRuntimeAdapter implements RuntimeAdapter {
  createTask(intent: string, options?: { id?: string; priority?: JackClawTask['priority']; timeoutMs?: number }): { id: string } {
    return runtime.createTask(intent, options);
  }

  setPlan(id: string, plan: ExecutionPlan): unknown {
    return runtime.setPlan(id, plan);
  }

  async runTask(id: string): Promise<{ attempts: number; artifacts: Artifact[]; errors: Array<{ message: string }> }> {
    const result = await runtime.runTask(id);
    return {
      attempts: result.attempts,
      artifacts: result.artifacts,
      errors: result.errors.map((error) => ({ message: error.message })),
    };
  }
}

export class NodeIdentityManager {
  private identity: NodeIdentity;

  constructor(seed?: Partial<NodeIdentity>) {
    this.identity = this.createIdentity(seed);
  }

  async loadOrCreate(seed?: { nodeId?: string; signingSecret?: string; displayName?: string; role?: string }): Promise<NodeIdentity> {
    if (seed) {
      this.identity = this.createIdentity({
        ...this.identity,
        nodeId: seed.nodeId ?? this.identity.nodeId,
        sharedSecret: seed.signingSecret ?? this.identity.sharedSecret,
        displayName: seed.displayName ?? this.identity.displayName,
        role: seed.role ?? this.identity.role,
      });
    }
    return { ...this.identity };
  }

  async registerWithHub(hubUrl: string): Promise<void> {
    if (!hubUrl) {
      throw new Error('Hub URL is required for registration');
    }
  }

  sign(payload: unknown, signingSecret?: string): string {
    return createHmac('sha256', signingSecret ?? this.identity.sharedSecret).update(stableStringify(payload)).digest('hex');
  }

  verify(senderId: string, payload: unknown, signature: string, signingSecret?: string): boolean {
    if (!senderId || !signature) return false;
    const expected = this.sign(payload, signingSecret);
    return signature === expected;
  }

  private createIdentity(seed?: Partial<NodeIdentity>): NodeIdentity {
    const nodeId = seed?.nodeId ?? `node-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    const secretSource = seed?.sharedSecret ?? randomUUID();
    return {
      nodeId,
      publicKey: seed?.publicKey ?? sha256(`${nodeId}:public:${secretSource}`),
      privateKey: seed?.privateKey ?? sha256(`${nodeId}:private:${secretSource}`),
      sharedSecret: secretSource,
      displayName: seed?.displayName,
      role: seed?.role ?? 'jackcode',
      createdAt: seed?.createdAt ?? Date.now(),
    };
  }
}

export class JackClawNodeAdapter extends EventEmitter {
  private readonly config: JackClawAdapterConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly runtimeAdapter: RuntimeAdapter;
  private readonly now: () => number;
  private readonly identityManager: NodeIdentityManager;
  private readonly transport: NodeTransport;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly requestTimestamps: number[] = [];
  private readonly activeTasks = new Set<string>();
  private connected = false;
  private authenticated = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private inflightRequests = 0;
  private backoffMs: number;

  constructor(config: JackClawAdapterConfig, dependencies: NodeAdapterDependencies = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.runtimeAdapter = dependencies.runtimeAdapter ?? new DefaultRuntimeAdapter();
    this.now = dependencies.now ?? (() => Date.now());
    this.identityManager = new NodeIdentityManager({ nodeId: this.config.nodeId, displayName: this.config.nodeName, role: 'jackcode-node', sharedSecret: this.config.signingSecret });
    this.transport = dependencies.transportFactory ? dependencies.transportFactory(this.config) : this.createNoopTransport();
    this.backoffMs = this.config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs;
    this.bindTransport();
  }

  get nodeId(): string {
    return this.getIdentitySync().nodeId;
  }

  get identity(): NodeIdentityManager {
    return this.identityManager;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async start(): Promise<void> {
    await this.transport.connect();
    await this.register();
    this.startHeartbeat();
  }

  async stop(): Promise<void> {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Adapter stopped'));
    }
    this.pendingRequests.clear();
    await this.transport.close(1000, 'graceful shutdown');
    this.connected = false;
    this.authenticated = false;
  }

  async register(): Promise<void> {
    const identity = this.getIdentitySync();
    const payload: RegisterPayload = {
      nodeId: identity.nodeId,
      nodeName: this.config.nodeName ?? 'JackCode Node',
      port: this.config.port,
      role: 'jackcode-node',
      publicKey: identity.publicKey,
      capabilities: ['execute', 'review', 'report'],
      loadScore: this.computeLoadScore(),
    };
    await this.sendMessage('auth', payload, { awaitAck: false });
  }

  async handleTask(task: JackClawTask): Promise<TaskResult> {
    const startedAt = this.now();
    const taskId = sanitizeString(task.taskId || randomUUID(), 128);
    if (this.activeTasks.size >= (this.config.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks)) {
      throw new Error('Max concurrent tasks exceeded');
    }
    this.activeTasks.add(taskId);
    try {
      await this.sendProgress(taskId, {
        taskId,
        state: 'plan',
        message: `Planning task: ${sanitizeString(task.action, 512)}`,
        percentComplete: 10,
        timestamp: this.now(),
      });

      const runtimeTask = this.runtimeAdapter.createTask(task.action, {
        id: taskId,
        priority: task.priority,
        timeoutMs: task.timeoutMs,
      });

      const plan: ExecutionPlan = {
        steps: [
          {
            id: `${taskId}-step-1`,
            description: sanitizeString(task.action, 1_000),
            targetFiles: [],
            dependencies: [],
          },
        ],
        estimatedTokens: 1_000,
        targetModel: 'qwen',
      };

      this.runtimeAdapter.setPlan(runtimeTask.id, plan);
      await this.sendProgress(taskId, {
        taskId,
        state: 'execute',
        message: 'Executing task in JackCode runtime',
        percentComplete: 50,
        timestamp: this.now(),
      });

      const result = await this.runtimeAdapter.runTask(runtimeTask.id);
      const taskResult: TaskResult = {
        taskId,
        status: result.errors.length > 0 ? 'failure' : 'success',
        output: result.errors.length > 0 ? result.errors.map((error) => error.message).join('; ') : 'Task completed successfully',
        artifacts: result.artifacts.map((artifact) => ({
          type: artifact.type,
          path: artifact.path,
          content: artifact.content,
        })),
        error: result.errors.length > 0 ? result.errors[0]?.message : undefined,
        durationMs: this.now() - startedAt,
        attempts: result.attempts,
      };

      await this.sendCompletion(taskId, taskResult);
      return taskResult;
    } finally {
      this.activeTasks.delete(taskId);
    }
  }

  async sendProgress(taskId: string, progress: ProgressUpdate): Promise<void> {
    const message = this.buildSignedMessage('report', {
      type: 'progress',
      taskId,
      progress,
    }, {});
    await this.fetchImpl(this.config.hubUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
  }

  async sendCompletion(taskId: string, result: TaskResult): Promise<void> {
    const message = this.buildSignedMessage('report', {
      type: 'completion',
      taskId,
      result,
    }, {});
    await this.fetchImpl(this.config.hubUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
  }

  async sendDailyReport(report: DailyReport): Promise<void> {
    const message = this.buildSignedMessage('report', {
      type: 'daily_report',
      report,
    }, {});
    await this.fetchImpl(this.config.hubUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(message),
    });
  }

  getHealthSnapshot(): HealthSnapshot {
    return {
      nodeId: this.nodeId,
      connected: this.connected,
      authenticated: this.authenticated,
      inflightRequests: this.inflightRequests,
      activeTasks: this.activeTasks.size,
      queuedTasks: 0,
      loadScore: this.computeLoadScore(),
      resourceUsage: this.collectResourceUsage(),
      timestamp: this.now(),
    };
  }

  private bindTransport(): void {
    this.transport.onOpen(() => {
      this.connected = true;
      this.backoffMs = this.config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs;
      this.emit('open');
    });
    this.transport.onClose((code, reason) => {
      this.connected = false;
      this.authenticated = false;
      this.emit('close', code, reason);
      this.scheduleReconnect();
    });
    this.transport.onError((error) => {
      this.emit('error', error);
    });
    this.transport.onMessage((raw) => {
      void this.handleIncoming(raw);
    });
  }

  private async handleIncoming(raw: string): Promise<void> {
    let message: JackClawMessage;
    try {
      message = JSON.parse(raw) as JackClawMessage;
    } catch {
      return;
    }

    if (!this.verifyMessage(message)) {
      this.emit('warning', new Error('Discarded message with invalid signature'));
      return;
    }

    if (message.type === 'broadcast') {
      this.emit('broadcast', message.payload);
    }

    if (message.type === 'auth_ok') {
      this.authenticated = true;
    }
    if (message.type === 'ping') {
      await this.sendMessage('pong', { timestamp: this.now() }, { awaitAck: false, replyTo: message.id });
      return;
    }
    if (message.type === 'health') {
      await this.sendMessage('health_response', this.getHealthSnapshot(), { awaitAck: false, replyTo: message.id });
      return;
    }
    if (message.type === 'task') {
      await this.handleTask(message.payload as JackClawTask).catch((error) => {
        this.emit('task_error', error);
        throw error;
      });
    }

    const pendingKey = message.replyTo ?? message.correlationId ?? message.id;
    const pending = this.pendingRequests.get(pendingKey);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(pendingKey);
      pending.resolve(message);
    }
  }

  private verifyMessage(message: JackClawMessage): boolean {
    const { signature, ...unsigned } = message;
    const sharedSecret = this.config.signingSecret;
    return this.identityManager.verify(message.from, unsigned, signature, sharedSecret)
      || this.identityManager.verify(message.from, message.payload, signature, sharedSecret);
  }

  private buildSignedMessage(
    type: JackClawMessageType,
    payload: unknown,
    options: { correlationId?: string; replyTo?: string } = {}
  ): JackClawMessage {
    const identity = this.getIdentitySync();
    const message: Omit<JackClawMessage, 'signature'> = {
      id: randomUUID(),
      from: identity.nodeId,
      to: 'hub',
      type,
      payload: sanitizeRecord(payload),
      timestamp: this.now(),
      correlationId: options.correlationId,
      replyTo: options.replyTo,
    };
    return {
      ...message,
      signature: this.identityManager.sign(message),
    };
  }

  private async sendMessage(
    type: JackClawMessageType,
    payload: unknown,
    options: { awaitAck?: boolean; correlationId?: string; replyTo?: string } = {}
  ): Promise<JackClawMessage | void> {
    this.enforceRateLimit();
    const signed = this.buildSignedMessage(type, payload, { correlationId: options.correlationId, replyTo: options.replyTo });
    const raw = JSON.stringify(signed);
    if (Buffer.byteLength(raw, 'utf8') > (this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes)) {
      throw new Error('Payload exceeds configured size limit');
    }

    this.inflightRequests += 1;
    try {
      if (!options.awaitAck) {
        await this.transport.send(raw);
        return;
      }
      return await new Promise<JackClawMessage>(async (resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(signed.id);
          reject(new Error(`Request timed out for ${type}`));
        }, this.config.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs);
        this.pendingRequests.set(signed.id, { resolve, reject, timeout });
        try {
          await this.transport.send(raw);
        } catch (error) {
          clearTimeout(timeout);
          this.pendingRequests.delete(signed.id);
          reject(error as Error);
        }
      });
    } finally {
      this.inflightRequests = Math.max(0, this.inflightRequests - 1);
    }
  }

  private enforceRateLimit(): void {
    const limit = this.config.rateLimitPerMinute ?? DEFAULT_CONFIG.rateLimitPerMinute;
    const now = this.now();
    while (this.requestTimestamps.length > 0 && now - this.requestTimestamps[0]! > 60_000) {
      this.requestTimestamps.shift();
    }
    if (this.requestTimestamps.length >= limit) {
      throw new Error('Rate limit exceeded');
    }
    this.requestTimestamps.push(now);
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.transport.connect().catch((error) => {
        this.emit('error', error);
        this.backoffMs = Math.min(this.backoffMs * 2, this.config.maxReconnectIntervalMs ?? DEFAULT_CONFIG.maxReconnectIntervalMs);
        this.scheduleReconnect();
      });
    }, this.backoffMs);
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      const now = this.now();
      if (this.lastHeartbeatAt && now - this.lastHeartbeatAt > (this.config.heartbeatTimeoutMs ?? DEFAULT_CONFIG.heartbeatTimeoutMs)) {
        this.emit('warning', new Error('Heartbeat timeout detected'));
      }
      void this.sendMessage('ping', { timestamp: now }, { awaitAck: false }).catch((error) => this.emit('error', error));
      this.lastHeartbeatAt = now;
    }, this.config.heartbeatIntervalMs ?? DEFAULT_CONFIG.heartbeatIntervalMs);
  }

  private stopHeartbeat(): void {
    if (!this.heartbeatTimer) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  private getIdentitySync(): NodeIdentity {
    return this.identityManager['identity'] as NodeIdentity;
  }

  async sendRequest(type: JackClawMessageType, payload: unknown, options: { awaitReply?: boolean } = {}): Promise<JackClawMessage | void> {
    return this.sendMessage(type, payload, { awaitAck: options.awaitReply });
  }

  async handleRawMessage(raw: string): Promise<void> {
    if (Buffer.byteLength(raw, 'utf8') > (this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes)) {
      throw new Error('Payload too large');
    }

    let parsed: JackClawMessage;
    try {
      parsed = JSON.parse(raw) as JackClawMessage;
    } catch {
      throw new Error('Invalid message payload');
    }

    if (!this.verifyMessage(parsed)) {
      throw new Error('Invalid message signature');
    }

    await this.handleIncoming(raw);
  }

  private computeLoadScore(): number {
    const maxConcurrent = this.config.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks;
    const inflightWeight = Math.min(1, this.inflightRequests / Math.max(1, maxConcurrent));
    const activeWeight = Math.min(1, this.activeTasks.size / Math.max(1, maxConcurrent));
    return Number(((inflightWeight * 0.4) + (activeWeight * 0.6)).toFixed(2));
  }

  private collectResourceUsage(): ResourceUsage {
    const usage = process.memoryUsage();
    const cpu = process.cpuUsage();
    return {
      memoryRss: usage.rss,
      heapUsed: usage.heapUsed,
      heapTotal: usage.heapTotal,
      uptimeSeconds: process.uptime(),
      cpuUserMicros: cpu.user,
      cpuSystemMicros: cpu.system,
    };
  }

  private createNoopTransport(): NodeTransport {
    let openHandler: (() => void) | undefined;
    let closeHandler: ((code?: number, reason?: string) => void) | undefined;
    let _errorHandler: ((error: Error) => void) | undefined;
    let messageHandler: ((raw: string) => void) | undefined;
    const localNodeId = this.nodeId;
    const sign = (payload: unknown) => this.identityManager.sign(payload);

    return {
      onOpen(handler) {
        openHandler = handler;
      },
      onClose(handler) {
        closeHandler = handler;
      },
      onError(handler) {
        _errorHandler = handler;
      },
      onMessage(handler) {
        messageHandler = handler;
      },
      async connect() {
        openHandler?.();
      },
      async send(raw: string) {
        void raw;
        const ack = {
          id: randomUUID(),
          from: 'hub',
          to: localNodeId,
          type: 'ack',
          payload: {},
          timestamp: Date.now(),
        };
        messageHandler?.(JSON.stringify({
          ...ack,
          signature: sign(ack),
        }));
      },
      async close(code?: number, reason?: string) {
        closeHandler?.(code, reason);
      },
    };
  }
}

export class MessageRouter {
  serialize(message: JackClawMessage): string {
    return JSON.stringify(message);
  }

  deserialize(raw: string): JackClawMessage {
    return JSON.parse(raw) as JackClawMessage;
  }
}

export class TaskReceiver {
  private readonly handlers: Array<(task: JackClawTask) => Promise<TaskResult>> = [];

  constructor(private readonly identity: NodeIdentityManager) {}

  start(_port: number): void {}

  onTask(handler: (task: JackClawTask) => Promise<TaskResult>): void {
    this.handlers.push(handler);
  }

  async handleIncomingTask(message: JackClawMessage, signingSecret?: string): Promise<TaskResult> {
    const { signature, ...unsigned } = message;
    if (!this.identity.verify(message.from, unsigned, signature, signingSecret)
      && !this.identity.verify(message.from, message.payload, signature, signingSecret)) {
      throw new Error('Invalid message signature');
    }
    const payload = sanitizeRecord(message.payload) as unknown as JackClawTask;
    const handler = this.handlers[0];
    if (!handler) {
      throw new Error('No task handler registered');
    }
    return handler(payload);
  }
}

export class TaskRouter {
  constructor(private readonly runtimeAdapter: RuntimeAdapter) {}

  async route(task: JackClawTask, onProgress?: (progress: ProgressUpdate) => Promise<void> | void): Promise<TaskResult> {
    const startedAt = Date.now();
    const emit = async (state: ProgressUpdate['state'], message: string, percentComplete: number): Promise<void> => {
      await onProgress?.({
        taskId: task.taskId,
        state,
        message,
        percentComplete,
        timestamp: Date.now(),
      });
    };

    await emit('plan', `Planning task: ${task.action}`, 10);
    const runtimeTask = this.runtimeAdapter.createTask(task.action, {
      id: task.taskId,
      priority: task.priority,
      timeoutMs: task.timeoutMs,
    });
    this.runtimeAdapter.setPlan(runtimeTask.id, {
      steps: [{ id: `${task.taskId}-step-1`, description: task.action, targetFiles: [], dependencies: [] }],
      estimatedTokens: 1_000,
      targetModel: 'qwen',
    });
    await emit('execute', 'Executing task in JackCode runtime', 50);
    const result = await this.runtimeAdapter.runTask(runtimeTask.id);
    await emit('review', 'Reviewing runtime outputs', 85);
    await emit('done', 'Task completed', 100);
    return {
      taskId: task.taskId,
      status: result.errors.length > 0 ? 'failure' : 'success',
      output: result.errors.length > 0 ? result.errors.map((error) => error.message).join('; ') : 'Task completed successfully',
      artifacts: result.artifacts.map((artifact) => ({ type: artifact.type, path: artifact.path, content: artifact.content })),
      error: result.errors[0]?.message,
      durationMs: Date.now() - startedAt,
      attempts: result.attempts,
    };
  }
}

export class RateLimiter {
  private readonly timestamps: number[] = [];

  constructor(private readonly limitPerMinute: number, private readonly now: () => number = () => Date.now()) {}

  consume(): boolean {
    const current = this.now();
    while (this.timestamps.length > 0 && current - this.timestamps[0]! >= 60_000) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.limitPerMinute) {
      return false;
    }
    this.timestamps.push(current);
    return true;
  }
}

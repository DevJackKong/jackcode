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
      output[key] = value.slice(0, 50).map((entry) => {
        if (typeof entry === 'string') return sanitizeString(entry, 500);
        if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) return entry;
        if (typeof entry === 'object') return sanitizeRecord(entry, depth + 1);
        return String(entry);
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

  loadOrCreate(): NodeIdentity {
    return { ...this.identity };
  }

  async registerWithHub(hubUrl: string): Promise<void> {
    if (!hubUrl) {
      throw new Error('Hub URL is required for registration');
    }
  }

  sign(payload: unknown): string {
    return createHmac('sha256', this.identity.sharedSecret).update(stableStringify(payload)).digest('hex');
  }

  verify(senderId: string, payload: unknown, signature: string): boolean {
    if (!senderId || !signature) return false;
    const expected = this.sign(payload);
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
    this.identityManager = new NodeIdentityManager({ nodeId: this.config.nodeId, displayName: this.config.nodeName, role: 'jackcode-node' });
    this.transport = dependencies.transportFactory ? dependencies.transportFactory(this.config) : this.createNoopTransport();
    this.backoffMs = this.config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs;
    this.bindTransport();
  }

  get nodeId(): string {
    return this.identityManager.loadOrCreate().nodeId;
  }

  isConnected(): boolean {
    return this.connected;
  }

  isAuthenticated(): boolean {
    return this.authenticated;
  }

  async start(): Promise<void> {
    await this.transport.connect();
    if (this.config.autoRegister) {
      await this.register();
    }
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
    await this.transport.close(1000, 'shutdown');
    this.connected = false;
    this.authenticated = false;
  }

  async register(): Promise<void> {
    const identity = this.identityManager.loadOrCreate();
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
    await this.sendMessage('report', {
      kind: 'progress',
      taskId,
      progress,
    }, { awaitAck: false });
  }

  async sendCompletion(taskId: string, result: TaskResult): Promise<void> {
    await this.sendMessage('report', {
      kind: 'completion',
      taskId,
      result,
    }, { awaitAck: false });
  }

  async sendDailyReport(report: DailyReport): Promise<void> {
    await this.sendMessage('report', {
      kind: 'daily_report',
      report,
    }, { awaitAck: false });
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

    if (message.type === 'auth_ok') {
      this.authenticated = true;
    }
    if (message.type === 'ping') {
      await this.sendMessage('pong', { timestamp: this.now() }, { awaitAck: false, correlationId: message.id });
      return;
    }
    if (message.type === 'health') {
      await this.sendMessage('health_response', this.getHealthSnapshot(), { awaitAck: false, correlationId: message.id });
      return;
    }
    if (message.type === 'task') {
      void this.handleTask(message.payload as JackClawTask).catch((error) => {
        this.emit('task_error', error);
      });
    }

    const pendingKey = message.correlationId ?? message.replyTo ?? message.id;
    const pending = this.pendingRequests.get(pendingKey);
    if (pending) {
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(pendingKey);
      pending.resolve(message);
    }
  }

  private verifyMessage(message: JackClawMessage): boolean {
    const { signature, ...unsigned } = message;
    return this.identityManager.verify(message.from, unsigned, signature);
  }

  private async sendMessage(
    type: JackClawMessageType,
    payload: unknown,
    options: { awaitAck?: boolean; correlationId?: string } = {}
  ): Promise<JackClawMessage | void> {
    this.enforceRateLimit();
    const identity = this.identityManager.loadOrCreate();
    const message: Omit<JackClawMessage, 'signature'> = {
      id: randomUUID(),
      from: identity.nodeId,
      to: 'hub',
      type,
      payload: sanitizeRecord(payload),
      timestamp: this.now(),
      correlationId: options.correlationId,
    };
    const signed: JackClawMessage = {
      ...message,
      signature: this.identityManager.sign(message),
    };
    const raw = JSON.stringify(signed);
    if (Buffer.byteLength(raw, 'utf8') > (this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes)) {
      throw new Error('Payload exceeds configured size limit');
    }

    this.inflightRequests += 1;
    try {
      await this.transport.send(raw);
      if (!options.awaitAck) return;
      return await new Promise<JackClawMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(signed.id);
          reject(new Error(`Request timed out for ${type}`));
        }, this.config.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs);
        this.pendingRequests.set(signed.id, { resolve, reject, timeout });
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

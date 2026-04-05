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
    deepseek: number;
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
    const safeKey = sanitizeString(key, 128);
    if (!safeKey || safeKey === '__proto__' || safeKey === 'constructor' || safeKey === 'prototype') {
      continue;
    }

    if (typeof value === 'string') {
      output[safeKey] = sanitizeString(value);
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      output[safeKey] = value;
    } else if (Array.isArray(value)) {
      output[safeKey] = value
        .slice(0, 100)
        .flatMap((entry) => {
          if (typeof entry === 'string') return [sanitizeString(entry, 512)];
          if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null) return [entry];
          return [];
        });
    } else if (typeof value === 'object') {
      output[safeKey] = sanitizeRecord(value, depth + 1);
    }
  }

  return output;
}

function clampPercent(input: number | undefined): number | undefined {
  if (input === undefined) return undefined;
  if (!Number.isFinite(input)) return undefined;
  return Math.max(0, Math.min(100, input));
}

function createDefaultRuntimeAdapter(): RuntimeAdapter {
  return {
    createTask: (intent, options) => runtime.createTask(intent, options),
    setPlan: (id, plan) => runtime.setPlan(id, plan),
    runTask: (id) => runtime.runTask(id),
  };
}

export class NodeIdentityManager {
  private identity: NodeIdentity | null = null;

  async loadOrCreate(options?: { displayName?: string; role?: string; nodeId?: string; signingSecret?: string }): Promise<NodeIdentity> {
    const nodeId = options?.nodeId
      ?? (options?.displayName ? `${options.displayName.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}` : `jackcode-${Date.now().toString(36)}`);
    const sharedSecret = options?.signingSecret ?? `jackclaw-secret:${nodeId}`;

    this.identity = {
      nodeId,
      publicKey: `pub:${nodeId}`,
      privateKey: `priv:${nodeId}`,
      sharedSecret,
      displayName: options?.displayName,
      role: options?.role ?? 'code-executor',
      createdAt: Date.now(),
    };

    return this.identity;
  }

  getIdentity(): NodeIdentity {
    if (!this.identity) {
      throw new Error('Identity not loaded. Call loadOrCreate() first.');
    }
    return this.identity;
  }

  sign(payload: unknown, secret?: string): string {
    const identity = this.getIdentity();
    return createHmac('sha256', secret ?? identity.sharedSecret).update(stableStringify(payload)).digest('hex');
  }

  verify(senderId: string, payload: unknown, signature: string, secret?: string): boolean {
    const fallbackSecret = secret ?? `jackclaw-secret:${senderId}`;
    const expected = createHmac('sha256', fallbackSecret).update(stableStringify(payload)).digest('hex');
    return expected === signature;
  }
}

export class MessageRouter {
  serialize(message: JackClawMessage): string {
    return JSON.stringify(message);
  }

  deserialize(raw: string): JackClawMessage {
    const parsed = JSON.parse(raw) as Partial<JackClawMessage>;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid message payload');
    }
    if (typeof parsed.id !== 'string' || typeof parsed.from !== 'string' || typeof parsed.to !== 'string' || typeof parsed.type !== 'string') {
      throw new Error('Malformed message envelope');
    }
    if (typeof parsed.timestamp !== 'number' || typeof parsed.signature !== 'string') {
      throw new Error('Malformed message metadata');
    }
    return parsed as JackClawMessage;
  }
}

export class RateLimiter {
  private readonly timestamps: number[] = [];
  private readonly limitPerMinute: number;
  private readonly now: () => number;

  constructor(limitPerMinute: number, now: () => number = () => Date.now()) {
    this.limitPerMinute = limitPerMinute;
    this.now = now;
  }

  consume(): boolean {
    const cutoff = this.now() - 60_000;
    while (this.timestamps.length > 0 && this.timestamps[0]! < cutoff) {
      this.timestamps.shift();
    }
    if (this.timestamps.length >= this.limitPerMinute) {
      return false;
    }
    this.timestamps.push(this.now());
    return true;
  }
}

export class TaskReceiver {
  private readonly handlers: Array<(task: JackClawTask) => Promise<TaskResult | null>> = [];
  private readonly identityManager: NodeIdentityManager;
  private port = 0;
  private started = false;

  constructor(identityManager: NodeIdentityManager) {
    this.identityManager = identityManager;
  }

  start(port: number): void {
    if (this.started) {
      throw new Error('Task receiver already started');
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid receiver port: ${port}`);
    }
    this.port = port;
    this.started = true;
  }

  stop(): void {
    this.port = 0;
    this.started = false;
    this.handlers.length = 0;
  }

  onTask(handler: (task: JackClawTask) => Promise<TaskResult | null>): () => void {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }

  verifyMessage(message: JackClawMessage, secret?: string): boolean {
    return this.identityManager.verify(message.from, message.payload, message.signature, secret);
  }

  async handleIncomingTask(message: JackClawMessage, secret?: string): Promise<TaskResult> {
    if (!this.started) {
      throw new Error('Task receiver is not running');
    }
    if (message.type !== 'task') {
      throw new Error(`Unsupported message type: ${message.type}`);
    }
    if (!this.verifyMessage(message, secret)) {
      throw new Error('Message signature verification failed');
    }

    const task = this.parseTask(message.payload);
    for (const handler of this.handlers) {
      const result = await handler(task);
      if (result) return result;
    }
    throw new Error('No handler processed the task');
  }

  private parseTask(payload: unknown): JackClawTask {
    const parsed = payload as Partial<JackClawTask>;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid task payload');
    }
    if (typeof parsed.taskId !== 'string' || !parsed.taskId.trim()) {
      throw new Error('Task payload missing taskId');
    }
    if (typeof parsed.action !== 'string' || !parsed.action.trim()) {
      throw new Error('Task payload missing action');
    }
    return {
      taskId: sanitizeString(parsed.taskId, 128),
      action: sanitizeString(parsed.action, 256),
      params: sanitizeRecord(parsed.params),
      deadline: typeof parsed.deadline === 'number' ? parsed.deadline : undefined,
      priority: parsed.priority,
      requireApproval: typeof parsed.requireApproval === 'boolean' ? parsed.requireApproval : undefined,
      timeoutMs: typeof parsed.timeoutMs === 'number' ? parsed.timeoutMs : undefined,
    };
  }
}

export class TaskRouter {
  private readonly activeTasks = new Map<string, string>();
  private readonly runtimeAdapter: RuntimeAdapter;

  constructor(runtimeAdapter: RuntimeAdapter = createDefaultRuntimeAdapter()) {
    this.runtimeAdapter = runtimeAdapter;
  }

  async route(task: JackClawTask, onProgress?: (progress: ProgressUpdate) => Promise<void> | void): Promise<TaskResult> {
    const startTime = Date.now();

    const emit = async (state: ProgressUpdate['state'], message: string, percentComplete?: number): Promise<void> => {
      await onProgress?.({
        taskId: task.taskId,
        state,
        message,
        percentComplete: clampPercent(percentComplete),
        timestamp: Date.now(),
      });
    };

    try {
      await emit('plan', `Planning task ${task.action}`, 10);
      const created = this.runtimeAdapter.createTask(this.buildIntent(task), {
        id: task.taskId,
        priority: task.priority,
        timeoutMs: task.timeoutMs,
      });
      this.activeTasks.set(task.taskId, created.id);

      const plan = this.buildExecutionPlan(task);
      this.runtimeAdapter.setPlan(created.id, plan);

      await emit('execute', `Executing task ${task.action}`, 50);
      const completed = await this.runtimeAdapter.runTask(created.id);

      await emit('review', `Reviewing task ${task.action}`, 90);

      const errors = completed.errors ?? [];
      const artifacts = (completed.artifacts ?? []).map((artifact) => ({
        type: artifact.type,
        path: artifact.path,
        content: artifact.content,
      }));

      if (errors.length > 0 && artifacts.length === 0) {
        throw new Error(errors[errors.length - 1]?.message ?? 'Task failed');
      }

      await emit('done', `Task ${task.action} completed`, 100);
      return {
        taskId: task.taskId,
        status: 'success',
        output: `Task ${task.action} completed successfully`,
        artifacts,
        durationMs: Date.now() - startTime,
        attempts: completed.attempts ?? 1,
      };
    } catch (error) {
      await emit('error', error instanceof Error ? error.message : String(error), 100);
      return {
        taskId: task.taskId,
        status: 'failure',
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startTime,
        attempts: 1,
      };
    } finally {
      this.activeTasks.delete(task.taskId);
    }
  }

  getRuntimeTaskId(jackclawTaskId: string): string | undefined {
    return this.activeTasks.get(jackclawTaskId);
  }

  private buildIntent(task: JackClawTask): string {
    const params = Object.entries(task.params)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(', ');
    return params ? `${task.action}: ${params}` : task.action;
  }

  private buildExecutionPlan(task: JackClawTask): ExecutionPlan {
    const files = Array.isArray(task.params.files)
      ? task.params.files.filter((value): value is string => typeof value === 'string')
      : [];

    return {
      steps: [
        {
          id: `step-${task.taskId}`,
          description: `Execute ${task.action}`,
          targetFiles: files,
          dependencies: [],
        },
      ],
      estimatedTokens: 4000,
      targetModel: 'qwen',
    };
  }
}

export class ReportSender {
  private readonly config: JackClawAdapterConfig;
  private readonly identityManager: NodeIdentityManager;
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: JackClawAdapterConfig,
    identityManager: NodeIdentityManager,
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.identityManager = identityManager;
    this.fetchImpl = fetchImpl;
  }

  async sendProgress(taskId: string, progress: ProgressUpdate): Promise<void> {
    await this.send('report', { ...progress, type: 'progress', taskId });
  }

  async sendCompletion(taskId: string, result: TaskResult): Promise<void> {
    await this.send('report', { type: 'completion', taskId, result });
  }

  async sendDailyReport(report: DailyReport): Promise<void> {
    await this.send('report', { type: 'daily', report });
  }

  async sendHealth(snapshot: HealthSnapshot): Promise<void> {
    await this.send('health_response', snapshot);
  }

  private async send(type: JackClawMessageType, payload: unknown): Promise<void> {
    const identity = this.identityManager.getIdentity();
    const message: JackClawMessage = {
      id: randomUUID(),
      from: identity.nodeId,
      to: 'hub',
      type,
      payload,
      timestamp: Date.now(),
      signature: this.identityManager.sign(payload),
    };

    const url = new URL('/api/v1/reports', this.config.hubUrl).toString();
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.authToken ? { authorization: `Bearer ${this.config.authToken}` } : {}),
      },
      body: JSON.stringify(message),
    }).catch((error: unknown) => {
      const messageText = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send report to ${url}: ${messageText}`);
    });

    if (!response.ok) {
      throw new Error(`Hub request failed (${response.status} ${response.statusText})`);
    }
  }
}

export class JackClawNodeAdapter extends EventEmitter {
  public readonly identity: NodeIdentityManager;
  public readonly receiver: TaskReceiver;
  public readonly router: TaskRouter;
  public readonly reporter: ReportSender;
  public readonly messageRouter: MessageRouter;
  public readonly rateLimiter: RateLimiter;

  private readonly config: JackClawAdapterConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly runtimeAdapter: RuntimeAdapter;
  private readonly now: () => number;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly inflightTasks = new Set<string>();
  private transport: NodeTransport | null = null;
  private isRunning = false;
  private authenticated = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lastHeartbeatAt = 0;
  private unregisterTaskHandler: (() => void) | null = null;

  constructor(config: JackClawAdapterConfig, dependencies: NodeAdapterDependencies = {}) {
    super();
    this.config = {
      ...DEFAULT_CONFIG,
      ...config,
    };
    this.fetchImpl = dependencies.fetchImpl ?? fetch;
    this.runtimeAdapter = dependencies.runtimeAdapter ?? createDefaultRuntimeAdapter();
    this.now = dependencies.now ?? (() => Date.now());
    this.identity = new NodeIdentityManager();
    this.receiver = new TaskReceiver(this.identity);
    this.router = new TaskRouter(this.runtimeAdapter);
    this.reporter = new ReportSender(this.config, this.identity, this.fetchImpl);
    this.messageRouter = new MessageRouter();
    this.rateLimiter = new RateLimiter(this.config.rateLimitPerMinute ?? DEFAULT_CONFIG.rateLimitPerMinute, this.now);

    if (dependencies.transportFactory) {
      this.transport = dependencies.transportFactory(this.config);
      this.bindTransport(this.transport);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Adapter already running');
    }

    await this.identity.loadOrCreate({
      nodeId: this.config.nodeId,
      displayName: this.config.nodeName,
      role: 'code-executor',
      signingSecret: this.config.signingSecret,
    });

    this.receiver.start(this.config.port);
    this.unregisterTaskHandler = this.receiver.onTask(async (task) => this.executeTask(task));

    if (this.config.autoRegister) {
      await this.registerWithHub();
    }

    if (this.transport) {
      await this.transport.connect();
    }

    this.isRunning = true;
  }

  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    this.clearTimers();
    this.authenticated = false;
    this.unregisterTaskHandler?.();
    this.unregisterTaskHandler = null;
    this.receiver.stop();

    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(`Request ${id} cancelled during shutdown`));
    }
    this.pendingRequests.clear();

    if (this.transport) {
      await this.transport.close(1000, 'graceful shutdown');
    }

    this.emit('shutdown', this.getHealthSnapshot());
    this.isRunning = false;
  }

  async sendRequest(type: JackClawMessageType, payload: unknown, options: { to?: string; awaitReply?: boolean } = {}): Promise<JackClawMessage | void> {
    if (!this.transport) {
      throw new Error('Transport not configured');
    }
    const identity = this.identity.getIdentity();
    const message: JackClawMessage = {
      id: randomUUID(),
      from: identity.nodeId,
      to: options.to ?? 'hub',
      type,
      payload,
      timestamp: this.now(),
      signature: this.identity.sign(payload),
    };

    let replyPromise: Promise<JackClawMessage> | undefined;
    if (options.awaitReply) {
      replyPromise = new Promise<JackClawMessage>((resolve, reject) => {
        const timeout = setTimeout(() => {
          this.pendingRequests.delete(message.id);
          reject(new Error(`Request ${message.id} timed out`));
        }, this.config.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs);
        timeout.unref?.();
        this.pendingRequests.set(message.id, { resolve, reject, timeout });
      });
    }

    try {
      await this.transport.send(this.messageRouter.serialize(message));
    } catch (error) {
      if (options.awaitReply) {
        const pending = this.pendingRequests.get(message.id);
        if (pending) {
          clearTimeout(pending.timeout);
          this.pendingRequests.delete(message.id);
          pending.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
      throw error;
    }

    return replyPromise;
  }

  async handleRawMessage(raw: string): Promise<void> {
    if (!this.rateLimiter.consume()) {
      throw new Error('Rate limit exceeded');
    }
    if (Buffer.byteLength(raw, 'utf8') > (this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes)) {
      throw new Error('Payload too large');
    }

    const message = this.messageRouter.deserialize(raw);
    if (!this.identity.verify(message.from, message.payload, message.signature, this.config.signingSecret)) {
      throw new Error('Invalid message signature');
    }

    this.lastHeartbeatAt = this.now();

    if (message.replyTo && this.pendingRequests.has(message.replyTo)) {
      const pending = this.pendingRequests.get(message.replyTo)!;
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.replyTo);
      pending.resolve(message);
      return;
    }

    switch (message.type) {
      case 'auth_ok':
        this.authenticated = true;
        this.reconnectAttempts = 0;
        this.startHeartbeat();
        this.emit('authenticated', message);
        break;
      case 'auth_error':
        this.authenticated = false;
        throw new Error(typeof message.payload === 'string' ? message.payload : 'Authentication rejected');
      case 'ping':
        await this.sendReply(message, 'pong', { ok: true, timestamp: this.now() });
        break;
      case 'health':
        await this.sendReply(message, 'health_response', this.getHealthSnapshot());
        break;
      case 'broadcast':
        this.emit('broadcast', message.payload);
        break;
      case 'task':
        await this.receiver.handleIncomingTask(message, this.config.signingSecret);
        break;
      case 'shutdown':
        await this.stop();
        break;
      case 'ack':
      case 'pong':
      case 'health_response':
      case 'report':
      case 'auth':
        this.emit('message', message);
        break;
      default:
        throw new Error(`Unsupported message type: ${message.type satisfies never}`);
    }
  }

  async authenticate(): Promise<void> {
    const identity = this.identity.getIdentity();
    const token = this.config.authToken;
    if (!token || !token.trim()) {
      throw new Error('Missing auth token');
    }

    const payload = {
      nodeId: identity.nodeId,
      nodeName: this.config.nodeName ?? identity.nodeId,
      tokenHash: createHash('sha256').update(token).digest('hex'),
      timestamp: this.now(),
    };
    await this.sendRequest('auth', payload, { awaitReply: false });
  }

  getHealthSnapshot(): HealthSnapshot {
    const usage = process.memoryUsage();
    const cpu = process.cpuUsage();
    const activeTasks = this.inflightTasks.size;
    const queuedTasks = typeof (runtime as { getQueue?: () => unknown[] }).getQueue === 'function'
      ? (((runtime as { getQueue: () => unknown[] }).getQueue())?.length ?? 0)
      : 0;
    const loadScore = Math.min(1, (activeTasks + queuedTasks) / Math.max(1, this.config.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks));

    return {
      nodeId: this.identity.getIdentity().nodeId,
      connected: Boolean(this.transport),
      authenticated: this.authenticated,
      inflightRequests: this.pendingRequests.size,
      activeTasks,
      queuedTasks,
      loadScore,
      resourceUsage: {
        memoryRss: usage.rss,
        heapUsed: usage.heapUsed,
        heapTotal: usage.heapTotal,
        uptimeSeconds: process.uptime(),
        cpuUserMicros: cpu.user,
        cpuSystemMicros: cpu.system,
      },
      timestamp: this.now(),
    };
  }

  getStatus(): { running: boolean; nodeId: string | null; port: number; hubUrl: string; authenticated: boolean; connected: boolean } {
    let nodeId: string | null = null;
    try {
      nodeId = this.identity.getIdentity().nodeId;
    } catch {
      nodeId = null;
    }

    return {
      running: this.isRunning,
      nodeId,
      port: this.config.port,
      hubUrl: this.config.hubUrl,
      authenticated: this.authenticated,
      connected: Boolean(this.transport),
    };
  }

  private async executeTask(task: JackClawTask): Promise<TaskResult> {
    if (this.inflightTasks.size >= (this.config.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks)) {
      return {
        taskId: task.taskId,
        status: 'failure',
        error: 'Node is at task capacity',
        durationMs: 0,
        attempts: 0,
      };
    }

    this.inflightTasks.add(task.taskId);
    try {
      const result = await this.router.route(task, async (progress) => {
        await this.reporter.sendProgress(task.taskId, progress);
      });
      await this.reporter.sendCompletion(task.taskId, result);
      return result;
    } finally {
      this.inflightTasks.delete(task.taskId);
    }
  }

  private async registerWithHub(): Promise<void> {
    const identity = this.identity.getIdentity();
    const payload: RegisterPayload = {
      nodeId: identity.nodeId,
      nodeName: this.config.nodeName ?? identity.nodeId,
      port: this.config.port,
      role: identity.role ?? 'code-executor',
      publicKey: identity.publicKey,
      capabilities: ['tasks', 'progress', 'health', 'broadcasts'],
      loadScore: this.getHealthSnapshot().loadScore,
    };

    const url = new URL('/api/v1/nodes/register', this.config.hubUrl).toString();
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(this.config.authToken ? { authorization: `Bearer ${this.config.authToken}` } : {}),
      },
      body: JSON.stringify(payload),
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to register node with Hub: ${message}`);
    });

    if (!response.ok) {
      throw new Error(`Hub registration failed (${response.status} ${response.statusText})`);
    }
  }

  private bindTransport(transport: NodeTransport): void {
    transport.onOpen(() => {
      this.lastHeartbeatAt = this.now();
      void this.authenticate().catch((error) => this.emit('error', error));
    });

    transport.onMessage((raw) => {
      void this.handleRawMessage(raw).catch((error) => this.emit('error', error));
    });

    transport.onError((error) => {
      this.emit('error', error);
    });

    transport.onClose(() => {
      this.authenticated = false;
      this.clearHeartbeat();
      if (this.isRunning) {
        this.scheduleReconnect();
      }
    });
  }

  private async sendReply(request: JackClawMessage, type: JackClawMessageType, payload: unknown): Promise<void> {
    if (!this.transport) {
      return;
    }
    const identity = this.identity.getIdentity();
    const response: JackClawMessage = {
      id: randomUUID(),
      from: identity.nodeId,
      to: request.from,
      type,
      payload,
      timestamp: this.now(),
      signature: this.identity.sign(payload),
      replyTo: request.id,
      correlationId: request.correlationId ?? request.id,
    };
    await this.transport.send(this.messageRouter.serialize(response));
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (!this.transport) {
        return;
      }
      if (this.now() - this.lastHeartbeatAt > (this.config.heartbeatTimeoutMs ?? DEFAULT_CONFIG.heartbeatTimeoutMs)) {
        void this.transport.close(4000, 'heartbeat timeout');
        return;
      }
      void this.sendRequest('ping', { timestamp: this.now() }).catch((error) => this.emit('error', error));
    }, this.config.heartbeatIntervalMs ?? DEFAULT_CONFIG.heartbeatIntervalMs);
    this.heartbeatTimer.unref?.();
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || !this.transport) {
      return;
    }
    const base = this.config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs;
    const max = this.config.maxReconnectIntervalMs ?? DEFAULT_CONFIG.maxReconnectIntervalMs;
    const delay = Math.min(max, base * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.transport || !this.isRunning) {
        return;
      }
      void this.transport.connect().catch((error) => this.emit('error', error));
    }, delay);
    this.reconnectTimer.unref?.();
  }
}

export function createJackClawAdapter(options?: Partial<JackClawAdapterConfig>, dependencies?: NodeAdapterDependencies): JackClawNodeAdapter {
  const config: JackClawAdapterConfig = {
    hubUrl: options?.hubUrl ?? process.env.JACKCLAW_HUB_URL ?? 'http://localhost:3000',
    nodeId: options?.nodeId,
    nodeName: options?.nodeName ?? 'jackcode-node',
    port: options?.port ?? 8080,
    autoRegister: options?.autoRegister ?? DEFAULT_CONFIG.autoRegister,
    reportCron: options?.reportCron ?? DEFAULT_CONFIG.reportCron,
    authToken: options?.authToken ?? process.env.JACKCLAW_AUTH_TOKEN,
    signingSecret: options?.signingSecret ?? process.env.JACKCLAW_SIGNING_SECRET,
    reconnectIntervalMs: options?.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs,
    maxReconnectIntervalMs: options?.maxReconnectIntervalMs ?? DEFAULT_CONFIG.maxReconnectIntervalMs,
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? DEFAULT_CONFIG.heartbeatIntervalMs,
    heartbeatTimeoutMs: options?.heartbeatTimeoutMs ?? DEFAULT_CONFIG.heartbeatTimeoutMs,
    requestTimeoutMs: options?.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs,
    rateLimitPerMinute: options?.rateLimitPerMinute ?? DEFAULT_CONFIG.rateLimitPerMinute,
    maxConcurrentTasks: options?.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks,
    maxPayloadBytes: options?.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes,
  };

  return new JackClawNodeAdapter(config, dependencies);
}

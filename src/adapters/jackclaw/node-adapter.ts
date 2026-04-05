/**
 * Thread 13: JackClaw Node Adapter
 * Bridges JackCode with JackClaw Node ecosystem
 */

import { runtime } from '../../core/runtime.js';

// ============================================================================
// Types
// ============================================================================

/**
 * JackClaw protocol message envelope
 */
export interface JackClawMessage {
  from: string;
  to: string;
  type: 'report' | 'task' | 'ack' | 'ping';
  payload: string;
  timestamp: number;
  signature: string;
}

/**
 * JackClaw task payload
 */
export interface JackClawTask {
  taskId: string;
  action: string;
  params: Record<string, unknown>;
  deadline?: number;
  priority?: 'low' | 'normal' | 'high' | 'critical';
  requireApproval?: boolean;
}

/**
 * JackClaw task result
 */
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

/**
 * Progress update for streaming to Hub
 */
export interface ProgressUpdate {
  taskId: string;
  state: 'plan' | 'execute' | 'repair' | 'review' | 'done' | 'error';
  message: string;
  percentComplete?: number;
  timestamp: number;
}

/**
 * Daily report payload
 */
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

/**
 * Node identity
 */
export interface NodeIdentity {
  nodeId: string;
  publicKey: string;
  privateKey: string;
  displayName?: string;
  role?: string;
  createdAt: number;
}

/**
 * Adapter configuration
 */
export interface JackClawAdapterConfig {
  hubUrl: string;
  nodeId?: string;
  nodeName?: string;
  port: number;
  autoRegister: boolean;
  reportCron: string;
}

/**
 * Registration payload sent to hub
 */
interface RegisterPayload {
  nodeId: string;
  nodeName: string;
  port: number;
  role: string;
  publicKey: string;
}

// ============================================================================
// NodeIdentityManager
// ============================================================================

/**
 * Manages JackClaw node identity and cryptography
 */
export class NodeIdentityManager {
  private identity: NodeIdentity | null = null;
  private keyDir: string;

  constructor(keyDir = '~/.jackclaw/keys') {
    this.keyDir = keyDir;
  }

  /**
   * Load existing identity or create new one
   */
  async loadOrCreate(options?: { displayName?: string; role?: string; nodeId?: string }): Promise<NodeIdentity> {
    const id = options?.nodeId
      ?? (options?.displayName
        ? `${options.displayName.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`
        : `jackcode-${Date.now().toString(36)}`);

    this.identity = {
      nodeId: id,
      publicKey: `pub:${id}`,
      privateKey: `priv:${id}`,
      displayName: options?.displayName,
      role: options?.role ?? 'code-executor',
      createdAt: Date.now(),
    };

    return this.identity;
  }

  /**
   * Get current identity
   */
  getIdentity(): NodeIdentity {
    if (!this.identity) {
      throw new Error('Identity not loaded. Call loadOrCreate() first.');
    }
    return this.identity;
  }

  /**
   * Sign a payload with node's private key
   */
  sign(payload: unknown): string {
    const identity = this.getIdentity();
    const data = JSON.stringify(payload);
    return `sig:${identity.nodeId}:${Buffer.from(data).toString('base64url')}`;
  }

  /**
   * Verify a signature from another node
   */
  verify(senderId: string, payload: unknown, signature: string): boolean {
    const expected = `sig:${senderId}:${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    return signature === expected;
  }
}

// ============================================================================
// TaskReceiver
// ============================================================================

/**
 * HTTP server for receiving tasks from JackClaw Hub
 */
export class TaskReceiver {
  private port = 0;
  private handlers: Array<(task: JackClawTask) => Promise<TaskResult | null>> = [];
  private identityManager: NodeIdentityManager;
  private started = false;

  constructor(identityManager: NodeIdentityManager) {
    this.identityManager = identityManager;
  }

  /**
   * Start HTTP server on specified port
   */
  start(port: number): void {
    if (this.started) {
      throw new Error('Task receiver already started');
    }
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new Error(`Invalid receiver port: ${port}`);
    }

    this.port = port;
    this.started = true;
    console.log(`[JackClawNode] Task receiver starting on port ${port}`);
  }

  /**
   * Stop the server
   */
  stop(): void {
    if (!this.started) {
      return;
    }

    console.log('[JackClawNode] Task receiver stopping');
    this.started = false;
    this.port = 0;
    this.handlers = [];
  }

  /**
   * Register task handler
   */
  onTask(handler: (task: JackClawTask) => Promise<TaskResult | null>): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((entry) => entry !== handler);
    };
  }

  /**
   * Verify incoming message signature
   */
  verifyMessage(msg: JackClawMessage): boolean {
    try {
      const payload = JSON.parse(msg.payload) as unknown;
      return this.identityManager.verify(msg.from, payload, msg.signature);
    } catch {
      return false;
    }
  }

  /**
   * Handle incoming task
   */
  async handleIncomingTask(msg: JackClawMessage): Promise<TaskResult> {
    if (!this.started) {
      throw new Error('Task receiver is not running');
    }
    if (msg.type !== 'task') {
      throw new Error(`Unsupported message type: ${msg.type}`);
    }
    if (!this.verifyMessage(msg)) {
      throw new Error('Message signature verification failed');
    }

    const task = this.parseTask(msg.payload);

    for (const handler of this.handlers) {
      const result = await handler(task);
      if (result) {
        return result;
      }
    }

    throw new Error('No handler processed the task');
  }

  /**
   * Parse and validate incoming task payload
   */
  private parseTask(payload: string): JackClawTask {
    const parsed = JSON.parse(payload) as Partial<JackClawTask>;
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('Invalid task payload');
    }
    if (typeof parsed.taskId !== 'string' || parsed.taskId.length === 0) {
      throw new Error('Task payload missing taskId');
    }
    if (typeof parsed.action !== 'string' || parsed.action.length === 0) {
      throw new Error('Task payload missing action');
    }

    return {
      taskId: parsed.taskId,
      action: parsed.action,
      params: this.normalizeParams(parsed.params),
      deadline: typeof parsed.deadline === 'number' ? parsed.deadline : undefined,
      priority: parsed.priority,
      requireApproval: typeof parsed.requireApproval === 'boolean' ? parsed.requireApproval : undefined,
    };
  }

  /**
   * Normalize task params
   */
  private normalizeParams(params: unknown): Record<string, unknown> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return {};
    }
    return params as Record<string, unknown>;
  }
}

// ============================================================================
// TaskRouter
// ============================================================================

/**
 * Routes JackClaw tasks to JackCode runtime
 */
export class TaskRouter {
  private identityManager: NodeIdentityManager;
  private activeTasks = new Map<string, string>();

  constructor(identityManager: NodeIdentityManager) {
    this.identityManager = identityManager;
  }

  /**
   * Route a JackClaw task to JackCode runtime
   */
  async route(task: JackClawTask): Promise<TaskResult> {
    const startTime = Date.now();

    console.log(`[JackClawNode] Routing task ${task.taskId}: ${task.action}`);

    try {
      this.identityManager.getIdentity();

      const taskContext = runtime.createTask(
        task.taskId,
        this.buildIntent(task),
        3,
      );

      this.activeTasks.set(task.taskId, taskContext.id);

      const plan = this.buildExecutionPlan(task);
      runtime.setPlan(taskContext.id, plan);
      runtime.transition(taskContext.id, 'execute');
      await this.simulateExecution(taskContext.id, task);
      runtime.transition(taskContext.id, 'review');
      runtime.transition(taskContext.id, 'done');

      const duration = Date.now() - startTime;
      return {
        taskId: task.taskId,
        status: 'success',
        output: `Task ${task.action} completed successfully`,
        durationMs: duration,
        attempts: 1,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const message = error instanceof Error ? error.message : String(error);

      return {
        taskId: task.taskId,
        status: 'failure',
        error: message,
        durationMs: duration,
        attempts: 1,
      };
    } finally {
      this.activeTasks.delete(task.taskId);
    }
  }

  /**
   * Build intent string from task
   */
  private buildIntent(task: JackClawTask): string {
    const params = Object.entries(task.params)
      .map(([key, value]) => `${key}=${typeof value === 'string' ? value : JSON.stringify(value)}`)
      .join(', ');
    return params.length > 0 ? `${task.action}: ${params}` : task.action;
  }

  /**
   * Build execution plan
   */
  private buildExecutionPlan(task: JackClawTask) {
    const files = Array.isArray(task.params.files)
      ? task.params.files.filter((value): value is string => typeof value === 'string')
      : [];

    return {
      steps: [
        {
          id: 'step-1',
          description: `Execute ${task.action}`,
          targetFiles: files,
          dependencies: [],
        },
      ],
      estimatedTokens: 4000,
      targetModel: 'qwen' as const,
    };
  }

  /**
   * Simulate task execution (placeholder)
   */
  private async simulateExecution(taskId: string, task: JackClawTask): Promise<void> {
    if (typeof task.deadline === 'number' && task.deadline < Date.now()) {
      throw new Error(`Task ${task.taskId} missed its deadline`);
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
    runtime.addArtifact(taskId, {
      id: `${taskId}-artifact`,
      type: 'log',
      path: `runtime/${taskId}.log`,
      content: `Executed ${task.action}`,
    });
  }

  /**
   * Get runtime task ID from JackClaw task ID
   */
  getRuntimeTaskId(jackclawTaskId: string): string | undefined {
    return this.activeTasks.get(jackclawTaskId);
  }
}

// ============================================================================
// ReportSender
// ============================================================================

/**
 * Sends execution reports back to JackClaw Hub
 */
export class ReportSender {
  private config: JackClawAdapterConfig;
  private identityManager: NodeIdentityManager;

  constructor(config: JackClawAdapterConfig, identityManager: NodeIdentityManager) {
    this.config = config;
    this.identityManager = identityManager;
  }

  /**
   * Send progress update for a task
   */
  async sendProgress(taskId: string, progress: ProgressUpdate): Promise<void> {
    const identity = this.identityManager.getIdentity();
    const payload = { type: 'progress', taskId, ...progress };
    const message: JackClawMessage = {
      from: identity.nodeId,
      to: 'hub',
      type: 'report',
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
      signature: this.identityManager.sign(payload),
    };

    await this.postToHub('/api/v1/reports', message);
  }

  /**
   * Send task completion report
   */
  async sendCompletion(taskId: string, result: TaskResult): Promise<void> {
    const identity = this.identityManager.getIdentity();
    const payload = { type: 'completion', taskId, result };
    const message: JackClawMessage = {
      from: identity.nodeId,
      to: 'hub',
      type: 'report',
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
      signature: this.identityManager.sign(payload),
    };

    await this.postToHub('/api/v1/reports', message);
  }

  /**
   * Send daily report
   */
  async sendDailyReport(report: DailyReport): Promise<void> {
    const identity = this.identityManager.getIdentity();
    const payload = { type: 'daily', report };
    const message: JackClawMessage = {
      from: identity.nodeId,
      to: 'hub',
      type: 'report',
      payload: JSON.stringify(payload),
      timestamp: Date.now(),
      signature: this.identityManager.sign(payload),
    };

    await this.postToHub('/api/v1/reports', message);
  }

  /**
   * POST message to Hub
   */
  private async postToHub(path: string, message: JackClawMessage): Promise<void> {
    const url = new URL(path, this.config.hubUrl).toString();

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new Error(`Hub request failed (${response.status} ${response.statusText})`);
      }
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to send report to ${url}: ${messageText}`);
    }
  }
}

// ============================================================================
// JackClawNodeAdapter (Main Class)
// ============================================================================

/**
 * Main JackClaw Node Adapter
 * Orchestrates identity, task reception, routing, and reporting
 */
export class JackClawNodeAdapter {
  public readonly identity: NodeIdentityManager;
  public readonly receiver: TaskReceiver;
  public readonly router: TaskRouter;
  public readonly reporter: ReportSender;

  private config: JackClawAdapterConfig;
  private isRunning = false;
  private unregisterTaskHandler: (() => void) | null = null;

  constructor(config: JackClawAdapterConfig) {
    this.config = config;
    this.identity = new NodeIdentityManager();
    this.receiver = new TaskReceiver(this.identity);
    this.router = new TaskRouter(this.identity);
    this.reporter = new ReportSender(config, this.identity);
  }

  /**
   * Initialize and start the adapter
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      throw new Error('Adapter already running');
    }

    console.log('[JackClawNode] Starting adapter...');

    await this.identity.loadOrCreate({
      nodeId: this.config.nodeId,
      displayName: this.config.nodeName,
      role: 'code-executor',
    });

    const id = this.identity.getIdentity();
    console.log(`[JackClawNode] Identity: ${id.nodeId}`);

    this.receiver.start(this.config.port);
    this.unregisterTaskHandler = this.receiver.onTask(async (task) => {
      const result = await this.router.route(task);
      await this.reporter.sendCompletion(task.taskId, result);
      return result;
    });

    if (this.config.autoRegister) {
      await this.registerWithHub();
    }

    this.isRunning = true;
    console.log('[JackClawNode] Adapter started successfully');
  }

  /**
   * Stop the adapter
   */
  async stop(): Promise<void> {
    if (!this.isRunning) {
      return;
    }

    console.log('[JackClawNode] Stopping adapter...');
    this.unregisterTaskHandler?.();
    this.unregisterTaskHandler = null;
    this.receiver.stop();
    this.isRunning = false;
    console.log('[JackClawNode] Adapter stopped');
  }

  /**
   * Register node with JackClaw Hub
   */
  private async registerWithHub(): Promise<void> {
    const identity = this.identity.getIdentity();
    const payload: RegisterPayload = {
      nodeId: identity.nodeId,
      nodeName: this.config.nodeName ?? identity.nodeId,
      port: this.config.port,
      role: identity.role ?? 'code-executor',
      publicKey: identity.publicKey,
    };

    const url = new URL('/api/v1/nodes/register', this.config.hubUrl).toString();
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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

  /**
   * Get adapter status
   */
  getStatus(): {
    running: boolean;
    nodeId: string | null;
    port: number;
    hubUrl: string;
  } {
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
    };
  }
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create adapter with default configuration
 */
export function createJackClawAdapter(options?: Partial<JackClawAdapterConfig>): JackClawNodeAdapter {
  const config: JackClawAdapterConfig = {
    hubUrl: options?.hubUrl ?? process.env.JACKCLAW_HUB_URL ?? 'http://localhost:3000',
    nodeId: options?.nodeId,
    nodeName: options?.nodeName ?? 'jackcode-node',
    port: options?.port ?? 8080,
    autoRegister: options?.autoRegister ?? true,
    reportCron: options?.reportCron ?? '0 8 * * *',
  };

  return new JackClawNodeAdapter(config);
}

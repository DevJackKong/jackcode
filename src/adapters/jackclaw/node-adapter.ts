/**
 * Thread 13: JackClaw Node Adapter
 * Bridges JackCode with JackClaw Node ecosystem
 */

import type { TaskContext, TaskState } from '../../core/runtime.js';
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
  state: TaskState;
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
  async loadOrCreate(options?: { displayName?: string; role?: string }): Promise<NodeIdentity> {
    // TODO: Implement actual key loading from ~/.jackclaw/keys/
    // For now, generate ephemeral identity
    const id = options?.displayName 
      ? `${options.displayName.toLowerCase().replace(/\s+/g, '-')}-${Date.now().toString(36)}`
      : `jackcode-${Date.now().toString(36)}`;
    
    this.identity = {
      nodeId: id,
      publicKey: '', // TODO: Generate RSA key pair
      privateKey: '',
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
    // TODO: Implement RSA signing
    const data = JSON.stringify(payload);
    return `sig-${Buffer.from(data).toString('base64').slice(0, 32)}`;
  }

  /**
   * Verify a signature from another node
   */
  verify(senderId: string, payload: unknown, signature: string): boolean {
    // TODO: Implement RSA verification
    // Check signature against sender's public key
    return signature.startsWith('sig-');
  }
}

// ============================================================================
// TaskReceiver
// ============================================================================

/**
 * HTTP server for receiving tasks from JackClaw Hub
 */
export class TaskReceiver {
  private port: number = 0;
  private handlers: Array<(task: JackClawTask) => Promise<TaskResult>> = [];
  private identityManager: NodeIdentityManager;

  constructor(identityManager: NodeIdentityManager) {
    this.identityManager = identityManager;
  }

  /**
   * Start HTTP server on specified port
   */
  start(port: number): void {
    this.port = port;
    console.log(`[JackClawNode] Task receiver starting on port ${port}`);
    // TODO: Implement Express server
    // POST /task - receive tasks
    // POST /ping - health check
  }

  /**
   * Stop the server
   */
  stop(): void {
    console.log('[JackClawNode] Task receiver stopping');
    // TODO: Close server
  }

  /**
   * Register task handler
   */
  onTask(handler: (task: JackClawTask) => Promise<TaskResult>): void {
    this.handlers.push(handler);
  }

  /**
   * Verify incoming message signature
   */
  verifyMessage(msg: JackClawMessage): boolean {
    try {
      const payload = JSON.parse(msg.payload);
      return this.identityManager.verify(msg.from, payload, msg.signature);
    } catch {
      return false;
    }
  }

  /**
   * Handle incoming task
   */
  async handleIncomingTask(msg: JackClawMessage): Promise<TaskResult> {
    if (!this.verifyMessage(msg)) {
      throw new Error('Message signature verification failed');
    }

    // TODO: Decrypt payload
    const task: JackClawTask = JSON.parse(msg.payload);

    // Route to all handlers (first one wins)
    for (const handler of this.handlers) {
      const result = await handler(task);
      if (result) return result;
    }

    throw new Error('No handler processed the task');
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
  private activeTasks: Map<string, string> = new Map(); // taskId -> runtime task ID

  constructor(identityManager: NodeIdentityManager) {
    this.identityManager = identityManager;
  }

  /**
   * Route a JackClaw task to JackCode runtime
   */
  async route(task: JackClawTask): Promise<TaskResult> {
    const startTime = Date.now();
    const identity = this.identityManager.getIdentity();

    console.log(`[JackClawNode] Routing task ${task.taskId}: ${task.action}`);

    try {
      // Convert JackClaw task to JackCode TaskContext
      const taskContext = runtime.createTask(
        task.taskId,
        this.buildIntent(task),
        3 // maxAttempts
      );

      this.activeTasks.set(task.taskId, taskContext.id);

      // Create execution plan
      const plan = this.buildExecutionPlan(task);
      runtime.setPlan(taskContext.id, plan);

      // Transition to execute
      runtime.transition(taskContext.id, 'execute');

      // TODO: Actually execute via model routers
      // For now, simulate execution
      await this.simulateExecution(taskContext.id);

      // Transition to review
      runtime.transition(taskContext.id, 'review');

      // Complete
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
    }
  }

  /**
   * Build intent string from task
   */
  private buildIntent(task: JackClawTask): string {
    const params = Object.entries(task.params)
      .map(([k, v]) => `${k}=${v}`)
      .join(', ');
    return `${task.action}: ${params}`;
  }

  /**
   * Build execution plan
   */
  private buildExecutionPlan(task: JackClawTask) {
    return {
      steps: [
        {
          id: 'step-1',
          description: `Execute ${task.action}`,
          targetFiles: task.params.files as string[] || [],
          dependencies: [],
        },
      ],
      estimatedTokens: 4000,
      targetModel: 'qwen' as const,
    };
  }

  /**
   * Simulate task execution (TODO: replace with actual model routing)
   */
  private async simulateExecution(taskId: string): Promise<void> {
    // Placeholder for actual execution
    await new Promise(resolve => setTimeout(resolve, 100));
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
    const message: JackClawMessage = {
      from: identity.nodeId,
      to: 'hub',
      type: 'report',
      payload: JSON.stringify({ type: 'progress', ...progress }),
      timestamp: Date.now(),
      signature: '', // TODO: Sign
    };

    console.log(`[JackClawNode] Sending progress for ${taskId}: ${progress.state}`);
    await this.postToHub(message);
  }

  /**
   * Send task completion report
   */
  async sendCompletion(taskId: string, result: TaskResult): Promise<void> {
    const identity = this.identityManager.getIdentity();
    const message: JackClawMessage = {
      from: identity.nodeId,
      to: 'hub',
      type: 'report',
      payload: JSON.stringify({ type: 'completion', result }),
      timestamp: Date.now(),
      signature: '', // TODO: Sign
    };

    console.log(`[JackClawNode] Sending completion for ${taskId}: ${result.status}`);
    await this.postToHub(message);
  }

  /**
   * Send daily report
   */
  async sendDailyReport(report: DailyReport): Promise<void> {
    const identity = this.identityManager.getIdentity();
    const message: JackClawMessage = {
      from: identity.nodeId,
      to: 'hub',
      type: 'report',
      payload: JSON.stringify({ type: 'daily', report }),
      timestamp: Date.now(),
      signature: '', // TODO: Sign
    };

    console.log(`[JackClawNode] Sending daily report: ${report.tasksCompleted} completed`);
    await this.postToHub(message);
  }

  /**
   * POST message to Hub
   */
  private async postToHub(message: JackClawMessage): Promise<void> {
    const url = `${this.config.hubUrl}/api/v1/reports`;
    
    try {
      // TODO: Implement actual HTTP POST with fetch/axios
      console.log(`[JackClawNode] POST to ${url}`);
    } catch (error) {
      console.error('[JackClawNode] Failed to send report:', error);
      throw error;
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
  private isRunning: boolean = false;

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

    // 1. Load or create identity
    await this.identity.loadOrCreate({
      displayName: this.config.nodeName,
      role: 'code-executor',
    });

    const id = this.identity.getIdentity();
    console.log(`[JackClawNode] Identity: ${id.nodeId}`);

    // 2. Start task receiver
    this.receiver.start(this.config.port);

    // 3. Register task handler
    this.receiver.onTask(async (task) => {
      // Route task and report result
      const result = await this.router.route(task);
      await this.reporter.sendCompletion(task.taskId, result);
      return result;
    });

    // 4. Auto-register with Hub if configured
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
    this.receiver.stop();
    this.isRunning = false;
    console.log('[JackClawNode] Adapter stopped');
  }

  /**
   * Register node with JackClaw Hub
   */
  private async registerWithHub(): Promise<void> {
    const identity = this.identity.getIdentity();
    const url = `${this.config.hubUrl}/api/v1/nodes/register`;

    console.log(`[JackClawNode] Registering with Hub at ${url}`);

    // TODO: Implement actual registration HTTP POST
    console.log(`[JackClawNode] Node ${identity.nodeId} registered`);
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
    return {
      running: this.isRunning,
      nodeId: this.identity.getIdentity()?.nodeId ?? null,
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

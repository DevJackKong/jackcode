/**
 * Thread 01: Runtime State Machine
 * Complete runtime orchestration for JackCode task execution.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Session, SessionManager } from './session.js';
import type { RecoveryEngine } from './repairer.js';
import { RepoScanner } from './scanner.ts';
import type { FileChange, FileIndex, ScanResult, ScannerConfig } from '../types/scanner.js';
import type { QwenRouteRequest, QwenRouteResult, RoutePriority } from '../model/types.js';
import type { HandoffPayload } from '../types/session.js';
import type { ChangeRequest, Patch, PatchPlan, PatchResult, RollbackResult } from '../types/patch.js';
import type { LoopRunResult, RunResult as BuildRunResult } from '../tools/test-runner.ts';
import {
  applyPatch as defaultApplyPatch,
  buildPatchFromRequest as defaultBuildPatchFromRequest,
  rollbackPatch as defaultRollbackPatch,
  validatePatch as defaultValidatePatch,
} from '../tools/patch.ts';
import { BuildTestLoopOrchestrator } from '../tools/test-runner.ts';
import type {
  ClassifiedFailure,
  RecoveryResult,
  RetryAttempt,
} from '../types/repairer.js';

export type RuntimeTaskState =
  | 'idle'
  | 'planning'
  | 'executing'
  | 'reviewing'
  | 'completed'
  | 'error'
  | 'retrying'
  | 'rolling_back';

export type TaskState = RuntimeTaskState;

export type ModelTier = 'qwen' | 'deepseek' | 'gpt54';

export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ErrorClassification =
  | 'timeout'
  | 'validation'
  | 'transient'
  | 'permanent'
  | 'safety'
  | 'unknown';

export interface PlanStep {
  id: string;
  description: string;
  targetFiles: string[];
  dependencies: string[];
}

export interface ExecutionPlan {
  steps: PlanStep[];
  estimatedTokens: number;
  targetModel: ModelTier;
}

export interface Artifact {
  id: string;
  type: 'file' | 'patch' | 'log' | 'checkpoint' | 'handoff';
  path: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ErrorLog {
  timestamp: number;
  state: RuntimeTaskState;
  message: string;
  recoverable: boolean;
  classification: ErrorClassification;
  details?: Record<string, unknown>;
}

export interface RuntimePatchRequest {
  description: string;
  targetPath: string;
  range?: { start: number; end: number };
  replacement?: string;
  insertion?: string;
}

export interface TaskContext {
  id: string;
  sessionId?: string;
  state: RuntimeTaskState;
  status: TaskStatus;
  intent: string;
  priority: TaskPriority;
  routePriority: RoutePriority;
  plan?: ExecutionPlan;
  attempts: number;
  maxAttempts: number;
  artifacts: Artifact[];
  errors: ErrorLog[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  timeoutMs?: number;
  deadlineAt?: number;
  retryCount: number;
  lastError?: ErrorLog;
  checkpointId?: string;
  metadata: Record<string, unknown>;
  handoff?: HandoffPayload;
}

export interface StateTransition {
  from: RuntimeTaskState;
  to: RuntimeTaskState;
  validator?: (ctx: TaskContext) => boolean;
}

export interface RuntimeTaskCreateOptions {
  id?: string;
  sessionId?: string;
  priority?: TaskPriority;
  routePriority?: RoutePriority;
  maxAttempts?: number;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
}

export interface RuntimePersistenceShape {
  activeTaskId: string | null;
  tasks: Array<PersistedTaskContext>;
}

interface PersistedTaskContext extends Omit<TaskContext, 'handoff'> {
  handoff?: SerializableHandoffPayload;
}

interface SerializableHandoffPayload extends Omit<HandoffPayload, 'timestamp' | 'currentTask' | 'taskStack'> {
  timestamp: string;
  currentTask: Omit<HandoffPayload['currentTask'], 'createdAt' | 'updatedAt'> & {
    createdAt: string;
    updatedAt: string;
  };
  taskStack: Array<
    Omit<HandoffPayload['taskStack'][number], 'createdAt' | 'updatedAt'> & {
      createdAt: string;
      updatedAt: string;
    }
  >;
}

export interface RuntimeEventMap {
  'task-created': { task: TaskContext };
  'task-enqueued': { task: TaskContext; queueLength: number };
  'task-started': { task: TaskContext };
  'task-cancelled': { task: TaskContext };
  'state-changed': { task: TaskContext; from: RuntimeTaskState; to: RuntimeTaskState };
  'task-completed': { task: TaskContext };
  'task-failed': { task: TaskContext; error: ErrorLog };
  'task-timeout': { task: TaskContext; error: ErrorLog };
  'task-recovered': { task: TaskContext; recovery: RecoveryResult };
  'task-persisted': { path: string };
  'task-restored': { task: TaskContext };
  'queue-drained': { remaining: number };
}

export interface SessionContextAdapter {
  createSession?(rootGoal: string, memoryPath?: string): { id: string };
  getSession?(sessionId: string): Session | undefined;
  pushTask?(sessionId: string, goal: string, options?: { metadata?: Record<string, unknown>; status?: 'pending' | 'in-progress' | 'completed' | 'blocked' | 'failed' }): { id: string } | null;
  restoreCheckpoint?(sessionId: string, checkpointIdOrTag: string): boolean;
  setScannerSnapshot?(sessionId: string, snapshot: unknown): boolean;
  updateTaskStatus?(sessionId: string, taskId: string, status: 'pending' | 'in-progress' | 'completed' | 'blocked'): boolean;
  prepareHandoff?(
    sessionId: string,
    fromModel: string,
    toModel: string,
    relevantFiles: Array<{ path: string; content: string; relevance: 'high' | 'medium' | 'low' }>,
    expectedActions: string[]
  ): HandoffPayload | null;
  createCheckpoint?(sessionId: string, files: string[], options?: { tag?: string; notes?: string; auto?: boolean }): Promise<{ id: string } | null>;
}

export interface RouterAdapter {
  route(request: QwenRouteRequest): Promise<QwenRouteResult>;
}

export interface ExecutorResult {
  success: boolean;
  artifacts?: Artifact[];
  targetFiles?: string[];
  relevantFiles?: Array<{ path: string; content: string; relevance: 'high' | 'medium' | 'low' }>;
  summary?: string;
  error?: string;
  patches?: RuntimePatchRequest[];
}

export interface ReviewResult {
  approved: boolean;
  artifacts?: Artifact[];
  summary?: string;
  issues?: string[];
}

export interface ExecutorAdapter {
  execute(task: TaskContext): Promise<ExecutorResult>;
  review?(task: TaskContext): Promise<ReviewResult>;
}

export interface RepairerAdapter {
  classifyError(error: unknown): ClassifiedFailure;
  attemptRecovery(context: {
    sessionId: string;
    taskId: string;
    currentState: string;
    lastCheckpointId?: string;
    failure: ClassifiedFailure;
    attemptHistory: RetryAttempt[];
    remainingRetries: number;
  }): Promise<RecoveryResult>;
}

export interface PatchEngineAdapter {
  buildPatchFromRequest(request: ChangeRequest): Promise<Patch>;
  validatePatch(patch: Patch): { valid: boolean; errors: string[] };
  applyPatch(plan: PatchPlan, sessionId?: string): Promise<PatchResult>;
  rollbackPatch(patchId: string): Promise<RollbackResult>;
}

export interface BuildTestAdapter {
  run(options?: Record<string, unknown>): Promise<LoopRunResult>;
}

export interface RepoScannerAdapter {
  scan(options?: { force?: boolean; paths?: string[]; includeBinary?: boolean }): Promise<ScanResult>;
  scanIncremental?(changes: FileChange[]): Promise<FileIndex | null>;
  getIndex?(): FileIndex | null;
}

export interface RuntimeDependencies {
  session?: SessionContextAdapter | SessionManager;
  router?: RouterAdapter;
  executor?: ExecutorAdapter;
  repairer?: RepairerAdapter | RecoveryEngine;
  patchEngine?: PatchEngineAdapter;
  buildTest?: BuildTestAdapter;
  repoScanner?: RepoScannerAdapter;
  scanner?: RepoScannerAdapter;
}

export interface RuntimeConfig {
  persistencePath: string;
  autoPersist: boolean;
  autoStart: boolean;
  repoRoot: string;
  scannerConfig?: Partial<ScannerConfig>;
}

const PRIORITY_WEIGHT: Record<TaskPriority, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

const ALLOWED_TRANSITIONS: StateTransition[] = [
  { from: 'idle', to: 'planning' },
  { from: 'planning', to: 'executing', validator: (ctx) => ctx.plan !== undefined },
  { from: 'planning', to: 'error' },
  { from: 'executing', to: 'reviewing' },
  { from: 'executing', to: 'retrying', validator: (ctx) => ctx.attempts < ctx.maxAttempts },
  { from: 'executing', to: 'rolling_back', validator: (ctx) => Boolean(ctx.checkpointId) },
  { from: 'executing', to: 'error' },
  { from: 'retrying', to: 'executing', validator: (ctx) => ctx.attempts <= ctx.maxAttempts },
  { from: 'retrying', to: 'rolling_back', validator: (ctx) => Boolean(ctx.checkpointId) },
  { from: 'retrying', to: 'error' },
  { from: 'rolling_back', to: 'retrying' },
  { from: 'rolling_back', to: 'error' },
  { from: 'reviewing', to: 'completed' },
  { from: 'reviewing', to: 'retrying', validator: (ctx) => ctx.attempts < ctx.maxAttempts },
  { from: 'reviewing', to: 'error' },
];

function now(): number {
  return Date.now();
}

function cloneTask(task: TaskContext): TaskContext {
  return JSON.parse(JSON.stringify(task)) as TaskContext;
}

function isSessionManagerLike(value: unknown): value is SessionContextAdapter {
  return Boolean(value) && typeof value === 'object';
}

function isRepairerLike(value: unknown): value is RepairerAdapter {
  return Boolean(value) && typeof value === 'object';
}

export class RuntimeStateMachine {
  private readonly tasks = new Map<string, TaskContext>();
  private readonly queue: string[] = [];
  private readonly events = new EventEmitter();
  private readonly config: RuntimeConfig;
  private readonly session?: SessionContextAdapter;
  private readonly router?: RouterAdapter;
  private readonly executor?: ExecutorAdapter;
  private readonly repairer?: RepairerAdapter;
  private readonly patchEngine: PatchEngineAdapter;
  private readonly buildTest: BuildTestAdapter;
  private readonly repoScanner: RepoScannerAdapter;
  private readonly explicitPatchEngine: boolean;
  private readonly explicitBuildTest: boolean;
  private readonly explicitRepoScanner: boolean;
  private repoScanResult: ScanResult | null = null;
  private repoIndex: FileIndex | null = null;
  private activeTaskId: string | null = null;
  private timeoutHandles = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(dependencies: RuntimeDependencies = {}, config: Partial<RuntimeConfig> = {}) {
    this.session = isSessionManagerLike(dependencies.session) ? normalizeSessionAdapter(dependencies.session) : undefined;
    this.router = dependencies.router;
    this.executor = dependencies.executor;
    this.repairer = isRepairerLike(dependencies.repairer)
      ? dependencies.repairer
      : undefined;

    this.config = {
      persistencePath: path.resolve(process.cwd(), '.jackcode', 'runtime-state.json'),
      autoPersist: true,
      autoStart: false,
      repoRoot: process.cwd(),
      ...config,
    };

    this.explicitPatchEngine = Boolean(dependencies.patchEngine);
    this.explicitBuildTest = Boolean(dependencies.buildTest);
    this.explicitRepoScanner = Boolean(dependencies.repoScanner ?? dependencies.scanner);

    this.patchEngine = dependencies.patchEngine ?? {
      buildPatchFromRequest: defaultBuildPatchFromRequest,
      validatePatch: defaultValidatePatch,
      applyPatch: defaultApplyPatch,
      rollbackPatch: defaultRollbackPatch,
    };

    this.buildTest = dependencies.buildTest ?? {
      run: async () => {
        const orchestrator = new BuildTestLoopOrchestrator({ rootDir: this.config.repoRoot });
        return orchestrator.run();
      },
    };

    this.repoScanner = dependencies.repoScanner ?? dependencies.scanner ?? new RepoScanner({
      rootDir: this.config.repoRoot,
      ...(this.config.scannerConfig ?? {}),
    });

    if (!dependencies.repoScanner && !dependencies.scanner) {
      void this.initializeRepoState();
    }
  }

  on<K extends keyof RuntimeEventMap>(event: K, handler: (payload: RuntimeEventMap[K]) => void): void {
    this.events.on(event, handler as (payload: unknown) => void);
  }

  off<K extends keyof RuntimeEventMap>(event: K, handler: (payload: RuntimeEventMap[K]) => void): void {
    this.events.off(event, handler as (payload: unknown) => void);
  }

  getSession(taskId: string): Session | undefined {
    const task = this.tasks.get(taskId);
    if (!task?.sessionId || !this.session?.getSession) {
      return undefined;
    }
    return this.session.getSession(task.sessionId);
  }

  getRepoIndex(): FileIndex | null {
    return this.repoIndex;
  }

  getRepoScanResult(): ScanResult | null {
    return this.repoScanResult;
  }

  createTask(intent: string, options: RuntimeTaskCreateOptions = {}): TaskContext {
    const normalizedIntent = intent.trim();
    if (!normalizedIntent) {
      throw new Error('Task intent is required');
    }

    const id = (options.id ?? randomUUID()).trim();
    if (!id) {
      throw new Error('Task id is required');
    }
    if (this.tasks.has(id)) {
      throw new Error(`Task ${id} already exists`);
    }

    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new Error('maxAttempts must be a positive integer');
    }

    const timeoutMs = options.timeoutMs;
    if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
      throw new Error('timeoutMs must be a positive number');
    }

    let sessionId = options.sessionId;
    if (!sessionId && this.session?.createSession) {
      sessionId = this.session.createSession(normalizedIntent).id;
    }

    const sessionTask = sessionId && this.session?.pushTask
      ? this.session.pushTask(sessionId, normalizedIntent, {
          metadata: { runtimeTaskId: id },
          status: 'pending',
        })
      : null;

    const createdAt = now();
    const task: TaskContext = {
      id,
      sessionId,
      state: 'idle',
      status: 'queued',
      intent: normalizedIntent,
      priority: options.priority ?? 'normal',
      routePriority: options.routePriority ?? this.mapPriorityToRoutePriority(options.priority ?? 'normal'),
      attempts: 0,
      maxAttempts,
      artifacts: [],
      errors: [],
      createdAt,
      updatedAt: createdAt,
      timeoutMs,
      retryCount: 0,
      metadata: { ...(options.metadata ?? {}), sessionTaskId: sessionTask?.id },
    };

    this.tasks.set(id, task);
    if (sessionId && this.session?.updateTaskStatus) {
      this.session.updateTaskStatus(sessionId, this.getSessionTaskId(task), 'pending');
    }
    this.emit('task-created', { task: cloneTask(task) });
    this.enqueueTask(id);
    return cloneTask(task);
  }

  getTask(id: string): TaskContext | undefined {
    const task = this.tasks.get(id);
    return task ? cloneTask(task) : undefined;
  }

  getTasksByState(state: RuntimeTaskState): TaskContext[] {
    return [...this.tasks.values()].filter((task) => task.state === state).map(cloneTask);
  }

  getQueue(): TaskContext[] {
    return this.queue.map((id) => cloneTask(this.mustGetTask(id)));
  }

  getActiveTask(): TaskContext | undefined {
    return this.activeTaskId ? this.getTask(this.activeTaskId) : undefined;
  }

  setPlan(id: string, plan: ExecutionPlan): TaskContext {
    this.validatePlan(plan);
    const task = this.mustGetTask(id);
    if (task.state !== 'idle' && task.state !== 'planning') {
      throw new Error(`Cannot set plan in state: ${task.state}`);
    }

    task.plan = {
      ...plan,
      steps: plan.steps.map((step) => ({
        ...step,
        targetFiles: [...step.targetFiles],
        dependencies: [...step.dependencies],
      })),
    };
    task.updatedAt = now();
    this.persistIfNeeded();
    return cloneTask(task);
  }

  addArtifact(id: string, artifact: Artifact): TaskContext {
    const task = this.mustGetTask(id);
    task.artifacts.push({ ...artifact, metadata: artifact.metadata ? { ...artifact.metadata } : undefined });
    task.updatedAt = now();
    this.persistIfNeeded();
    return cloneTask(task);
  }

  addError(
    id: string,
    message: string,
    recoverable = true,
    classification: ErrorClassification = 'unknown',
    details?: Record<string, unknown>
  ): TaskContext {
    const task = this.mustGetTask(id);
    const error = this.makeErrorLog(task.state, message, recoverable, classification, details);
    task.errors.push(error);
    task.lastError = error;
    task.updatedAt = now();
    this.persistIfNeeded();
    return cloneTask(task);
  }

  cancelTask(id: string, reason = 'Cancelled'): TaskContext {
    const task = this.mustGetTask(id);

    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled') {
      return cloneTask(task);
    }

    task.status = 'cancelled';
    task.updatedAt = now();
    this.clearTimeoutForTask(id);

    const index = this.queue.indexOf(id);
    if (index >= 0) {
      this.queue.splice(index, 1);
    }
    if (this.activeTaskId === id) {
      this.activeTaskId = null;
    }

    const error = this.makeErrorLog(task.state, reason, false, 'validation', { cancelled: true });
    task.errors.push(error);
    task.lastError = error;

    this.emit('task-cancelled', { task: cloneTask(task) });
    this.persistIfNeeded();
    return cloneTask(task);
  }

  transition(id: string, toState: RuntimeTaskState): TaskContext {
    const task = this.mustGetTask(id);
    this.transitionTask(task, toState);
    this.persistIfNeeded();
    return cloneTask(task);
  }

  routeToModel(task: TaskContext): ModelTier | null {
    if (task.plan?.targetModel) {
      return task.plan.targetModel;
    }

    switch (task.state) {
      case 'planning':
      case 'executing':
        return 'qwen';
      case 'retrying':
      case 'rolling_back':
        return 'deepseek';
      case 'reviewing':
        return 'gpt54';
      default:
        return null;
    }
  }

  async runNextTask(): Promise<TaskContext | null> {
    if (this.activeTaskId) {
      return this.getTask(this.activeTaskId) ?? null;
    }

    const nextId = this.queue.shift();
    if (!nextId) {
      this.emit('queue-drained', { remaining: 0 });
      return null;
    }

    const task = this.mustGetTask(nextId);
    await this.runTask(task.id);
    return cloneTask(this.mustGetTask(task.id));
  }

  async runTask(id: string): Promise<TaskContext> {
    const task = this.mustGetTask(id);
    if (task.status === 'cancelled') {
      return cloneTask(task);
    }
    if (this.activeTaskId && this.activeTaskId !== id) {
      throw new Error(`Task ${this.activeTaskId} is already running`);
    }

    const queuedIndex = this.queue.indexOf(id);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
    }

    this.activeTaskId = id;
    task.status = 'running';
    task.startedAt ??= now();
    task.updatedAt = now();
    task.deadlineAt = task.timeoutMs ? task.startedAt + task.timeoutMs : undefined;
    this.emit('task-started', { task: cloneTask(task) });
    this.applyTimeout(task);

    try {
      await this.enterPlanning(task);
      await this.enterExecution(task);
      await this.enterReview(task);

      this.transitionTask(task, 'completed');
      task.status = 'completed';
      task.completedAt = now();
      this.clearTimeoutForTask(task.id);
      this.activeTaskId = null;
      if (task.sessionId && this.session?.updateTaskStatus) {
        this.session.updateTaskStatus(task.sessionId, this.getSessionTaskId(task), 'completed');
      }
      this.emit('task-completed', { task: cloneTask(task) });
      this.persistIfNeeded();
      return cloneTask(task);
    } catch (error) {
      const finalTask = await this.handleTaskFailure(task, error);
      this.persistIfNeeded();
      return finalTask;
    } finally {
      if (this.activeTaskId === id && this.mustGetTask(id).status !== 'running') {
        this.activeTaskId = null;
      }
    }
  }

  persist(): void {
    const persistenceDir = path.dirname(this.config.persistencePath);
    mkdirSync(persistenceDir, { recursive: true });

    const payload: RuntimePersistenceShape = {
      activeTaskId: this.activeTaskId,
      tasks: [...this.tasks.values()].map((task) => this.serializeTask(task)),
    };

    writeFileSync(this.config.persistencePath, JSON.stringify(payload, null, 2), 'utf8');
    this.emit('task-persisted', { path: this.config.persistencePath });
  }

  recover(): TaskContext[] {
    const raw = readFileSync(this.config.persistencePath, 'utf8');
    const payload = JSON.parse(raw) as RuntimePersistenceShape;

    this.tasks.clear();
    this.queue.length = 0;
    this.activeTaskId = payload.activeTaskId;
    this.timeoutHandles.forEach((handle) => clearTimeout(handle));
    this.timeoutHandles.clear();

    const restored: TaskContext[] = [];
    for (const persistedTask of payload.tasks) {
      const task = this.deserializeTask(persistedTask);

      if (task.status === 'running') {
        task.status = 'queued';
        if (task.state === 'executing' || task.state === 'reviewing') {
          task.state = 'retrying';
        }
      }

      this.tasks.set(task.id, task);
      if (task.status === 'queued') {
        this.queue.push(task.id);
      }

      restored.push(cloneTask(task));
      this.emit('task-restored', { task: cloneTask(task) });
    }

    this.sortQueue();
    this.activeTaskId = null;
    this.persistIfNeeded();
    return restored;
  }

  private enqueueTask(id: string): void {
    this.queue.push(id);
    this.sortQueue();
    this.emit('task-enqueued', {
      task: cloneTask(this.mustGetTask(id)),
      queueLength: this.queue.length,
    });
    this.persistIfNeeded();

    if (this.config.autoStart && !this.activeTaskId) {
      void this.runNextTask();
    }
  }

  private sortQueue(): void {
    this.queue.sort((a, b) => {
      const taskA = this.mustGetTask(a);
      const taskB = this.mustGetTask(b);
      const priorityDelta = PRIORITY_WEIGHT[taskB.priority] - PRIORITY_WEIGHT[taskA.priority];
      if (priorityDelta !== 0) {
        return priorityDelta;
      }
      return taskA.createdAt - taskB.createdAt;
    });
  }

  private async enterPlanning(task: TaskContext): Promise<void> {
    this.transitionTask(task, 'planning');

    if (!task.plan) {
      task.plan = this.buildDefaultPlan(task);
      task.updatedAt = now();
    }

    this.validatePlan(task.plan);
    await this.refreshRepoScan({ force: true });
    task.metadata.repoScannedAt = this.repoIndex?.generatedAt ?? null;
    if (task.sessionId && this.session?.setScannerSnapshot && this.repoIndex) {
      this.session.setScannerSnapshot(task.sessionId, this.repoIndex);
    }

    if (task.sessionId && this.session?.updateTaskStatus) {
      this.session.updateTaskStatus(task.sessionId, this.getSessionTaskId(task), 'in-progress');
    }

    this.persistIfNeeded();
  }

  private async enterExecution(task: TaskContext): Promise<void> {
    this.transitionTask(task, 'executing');
    task.attempts += 1;
    task.updatedAt = now();

    if (task.sessionId && this.session?.createCheckpoint && task.plan) {
      const targetFiles = [...new Set(task.plan.steps.flatMap((step) => step.targetFiles))];
      const checkpoint = await this.session.createCheckpoint(task.sessionId, targetFiles, {
        tag: `runtime-${task.id}-attempt-${task.attempts}`,
        notes: `Auto checkpoint before execution for ${task.intent}`,
        auto: true,
      });
      if (checkpoint) {
        task.checkpointId = checkpoint.id;
        task.artifacts.push({
          id: `checkpoint-${checkpoint.id}`,
          type: 'checkpoint',
          path: checkpoint.id,
        });
      }
    }

    if (this.router && task.plan) {
      const request: QwenRouteRequest = {
        taskId: task.id,
        context: {
          content: task.intent,
          fragments: [],
          stats: {
            originalTokens: task.plan.estimatedTokens,
            finalTokens: task.plan.estimatedTokens,
            savedTokens: 0,
            ratio: 1,
            fragmentsDropped: 0,
            fragmentsSummarized: 0,
          },
          strategy: {
            level: 0,
            targetBudget: task.plan.estimatedTokens,
            preserveTypes: [],
            preserveTags: [],
            minPriority: 0,
          },
          compressedAt: now(),
        },
        operations: task.plan.steps.map((step) => ({
          id: step.id,
          type: 'edit',
          targetFile: step.targetFiles[0] ?? 'unknown',
          description: step.description,
          dependencies: [...step.dependencies],
        })),
        priority: task.routePriority,
        timeoutMs: task.timeoutMs ?? 60000,
      };

      const routeResult = await this.router.route(request);
      if (!routeResult.success) {
        throw new Error(routeResult.escalation ?? 'Router execution failed');
      }
    }

    this.throwIfTimedOut(task);

    const execution = this.executor
      ? await this.executor.execute(cloneTask(task))
      : { success: true, patches: this.buildFallbackPatchRequests(task) };

    if (execution.artifacts?.length) {
      task.artifacts.push(...execution.artifacts);
    }
    if (execution.summary) {
      task.artifacts.push({
        id: `log-${task.id}-${task.attempts}`,
        type: 'log',
        path: `runtime/${task.id}/execution.log`,
        content: execution.summary,
      });
    }
    if (!execution.success) {
      throw new Error(execution.error || 'Executor reported failure');
    }

    const patchRequests = execution.patches ?? [];
    const shouldRunPatchPipeline = (this.explicitPatchEngine || this.explicitBuildTest || this.explicitRepoScanner) && patchRequests.length > 0;

    if (shouldRunPatchPipeline && patchRequests.length > 0) {
      const patchPlan = await this.buildPatchPlan(task, patchRequests);
      const validationErrors = patchPlan.patches
        .flatMap((patch) => this.patchEngine.validatePatch(patch).errors.map((error) => `${patch.targetPath}: ${error}`));
      if (validationErrors.length > 0) {
        throw new Error(`Patch validation failed: ${validationErrors.join('; ')}`);
      }

      const patchResult = await this.patchEngine.applyPatch(patchPlan, task.sessionId);
      this.recordPatchArtifacts(task, patchPlan, patchResult);
      if (!patchResult.success) {
        throw new Error(patchResult.failed?.map((entry) => `${entry.patch.targetPath}: ${entry.error}`).join('; ') || 'Patch apply failed');
      }

      const changedFiles = patchPlan.patches.map((patch) => patch.targetPath);
      await this.refreshRepoAfterChanges(changedFiles);

      const testResult = await this.buildTest.run();
      this.recordBuildTestArtifacts(task, testResult);
      if (!testResult.success) {
        throw new Error(testResult.errors.join('; ') || testResult.output || 'Build/test pipeline failed');
      }
    }

    this.throwIfTimedOut(task);
    this.persistIfNeeded();
  }

  private async enterReview(task: TaskContext): Promise<void> {
    this.transitionTask(task, 'reviewing');

    if (task.sessionId && this.session?.prepareHandoff) {
      const handoff = this.session.prepareHandoff(
        task.sessionId,
        'qwen',
        'gpt54',
        task.plan?.steps.map((step) => ({
          path: step.targetFiles[0] ?? 'unknown',
          content: step.description,
          relevance: 'high' as const,
        })) ?? [],
        ['verify task result', 'check regressions', 'approve or request retry']
      );
      if (handoff) {
        task.handoff = handoff;
        task.artifacts.push({
          id: `handoff-${task.id}`,
          type: 'handoff',
          path: `runtime/${task.id}/handoff.json`,
          content: JSON.stringify(handoff, null, 2),
        });
      }
    }

    this.throwIfTimedOut(task);

    if (this.executor?.review) {
      const review = await this.executor.review(cloneTask(task));
      if (review.artifacts?.length) {
        task.artifacts.push(...review.artifacts);
      }
      if (!review.approved) {
        throw new Error(review.issues?.join('; ') || review.summary || 'Review rejected task');
      }
    }

    this.throwIfTimedOut(task);
    this.persistIfNeeded();
  }

  private async handleTaskFailure(task: TaskContext, failure: unknown): Promise<TaskContext> {
    const classified = this.classifyFailure(failure);
    const error = this.makeErrorLog(
      task.state,
      classified.reason,
      classified.retryable,
      this.mapFailureCategory(classified.category),
      { category: classified.category }
    );
    task.errors.push(error);
    task.lastError = error;
    task.updatedAt = now();

    if (task.deadlineAt && now() > task.deadlineAt) {
      this.emit('task-timeout', { task: cloneTask(task), error });
    }

    const recovery = this.repairer
      ? await this.repairer.attemptRecovery({
          sessionId: task.sessionId ?? `runtime-${task.id}`,
          taskId: task.id,
          currentState: task.state,
          lastCheckpointId: task.checkpointId,
          failure: classified,
          attemptHistory: task.errors.map((entry, index) => ({
            attemptNumber: index + 1,
            timestamp: entry.timestamp,
            error: entry.message,
            delayMs: 0,
          })),
          remainingRetries: Math.max(0, task.maxAttempts - task.attempts),
        })
      : undefined;

    if (recovery) {
      this.emit('task-recovered', { task: cloneTask(task), recovery });
      if (recovery.action === 'retry' && task.attempts < task.maxAttempts) {
        task.retryCount += 1;
        this.transitionTask(task, 'retrying');
        this.persistIfNeeded();
        return this.resumeRecoveredTask(task);
      }

      const canRollbackArtifacts = task.artifacts.some((artifact) => artifact.type === 'patch' && typeof artifact.metadata?.patchId === 'string');
      if (recovery.action === 'rollback' && (task.checkpointId || canRollbackArtifacts) && task.attempts < task.maxAttempts) {
        await this.rollbackTaskArtifacts(task);
        if (task.sessionId && task.checkpointId && this.session?.restoreCheckpoint) {
          this.session.restoreCheckpoint(task.sessionId, recovery.rollbackCheckpointId ?? task.checkpointId);
        }
        this.transitionTask(task, 'rolling_back');
        task.retryCount += 1;
        this.persistIfNeeded();
        this.transitionTask(task, 'retrying');
        this.persistIfNeeded();
        return this.resumeRecoveredTask(task);
      }
    }

    this.transitionTask(task, 'error');
    task.status = task.status === 'cancelled' ? 'cancelled' : 'failed';
    task.completedAt = now();
    this.clearTimeoutForTask(task.id);
    this.activeTaskId = null;

    if (task.sessionId && this.session?.updateTaskStatus) {
      this.session.updateTaskStatus(task.sessionId, this.getSessionTaskId(task), 'blocked');
    }

    this.emit('task-failed', { task: cloneTask(task), error });
    return cloneTask(task);
  }

  private async resumeRecoveredTask(task: TaskContext): Promise<TaskContext> {
    this.throwIfTimedOut(task);

    try {
      this.transitionTask(task, 'executing');
      await this.enterExecution(task);
      await this.enterReview(task);

      this.transitionTask(task, 'completed');
      task.status = 'completed';
      task.completedAt = now();
      this.clearTimeoutForTask(task.id);
      this.activeTaskId = null;
      if (task.sessionId && this.session?.updateTaskStatus) {
        this.session.updateTaskStatus(task.sessionId, this.getSessionTaskId(task), 'completed');
      }
      this.emit('task-completed', { task: cloneTask(task) });
      this.persistIfNeeded();
      return cloneTask(task);
    } catch (error) {
      return this.handleTaskFailure(task, error);
    }
  }

  private transitionTask(task: TaskContext, to: RuntimeTaskState): void {
    const from = task.state;
    if (from === to) {
      return;
    }

    const transition = ALLOWED_TRANSITIONS.find((candidate) => candidate.from === from && candidate.to === to);
    if (!transition) {
      throw new Error(`Invalid transition: ${from} -> ${to}`);
    }
    if (transition.validator && !transition.validator(task)) {
      throw new Error(`Transition validation failed: ${from} -> ${to}`);
    }

    task.state = to;
    task.updatedAt = now();
    this.syncSessionState(task, to);
    this.emit('state-changed', { task: cloneTask(task), from, to });
  }

  private syncSessionState(task: TaskContext, state: RuntimeTaskState): void {
    if (!task.sessionId || !this.session?.updateTaskStatus) {
      return;
    }

    const mappedStatus = (() => {
      switch (state) {
        case 'completed':
          return 'completed' as const;
        case 'error':
        case 'rolling_back':
          return 'blocked' as const;
        default:
          return 'in-progress' as const;
      }
    })();

    this.session.updateTaskStatus(task.sessionId, this.getSessionTaskId(task), mappedStatus);
  }

  private applyTimeout(task: TaskContext): void {
    this.clearTimeoutForTask(task.id);
    if (!task.timeoutMs) {
      return;
    }

    const handle = setTimeout(() => {
      const current = this.tasks.get(task.id);
      if (!current || current.status !== 'running') {
        return;
      }

      const error = this.makeErrorLog(
        current.state,
        `Task timed out after ${task.timeoutMs}ms`,
        current.attempts < current.maxAttempts,
        'timeout'
      );
      current.errors.push(error);
      current.lastError = error;
      current.status = 'failed';
      current.updatedAt = now();
      this.activeTaskId = null;
      this.emit('task-timeout', { task: cloneTask(current), error });
      this.persistIfNeeded();
    }, task.timeoutMs);

    handle.unref?.();
    this.timeoutHandles.set(task.id, handle);
  }

  private throwIfTimedOut(task: TaskContext): void {
    if (task.status === 'failed' && task.lastError?.classification === 'timeout') {
      throw new Error(task.lastError.message);
    }
  }

  private clearTimeoutForTask(taskId: string): void {
    const handle = this.timeoutHandles.get(taskId);
    if (handle) {
      clearTimeout(handle);
      this.timeoutHandles.delete(taskId);
    }
  }

  private buildDefaultPlan(task: TaskContext): ExecutionPlan {
    return {
      steps: [
        {
          id: `${task.id}-step-1`,
          description: task.intent,
          targetFiles: [],
          dependencies: [],
        },
      ],
      estimatedTokens: Math.max(256, Math.min(16000, task.intent.length * 12)),
      targetModel: 'qwen',
    };
  }

  private validatePlan(plan: ExecutionPlan): void {
    if (!Number.isFinite(plan.estimatedTokens) || plan.estimatedTokens <= 0) {
      throw new Error('Plan estimatedTokens must be a positive number');
    }
    if (!plan.steps.length) {
      throw new Error('Plan must contain at least one step');
    }

    const ids = new Set<string>();
    for (const step of plan.steps) {
      if (!step.id.trim()) {
        throw new Error('Plan step id is required');
      }
      if (!step.description.trim()) {
        throw new Error(`Plan step ${step.id} description is required`);
      }
      if (ids.has(step.id)) {
        throw new Error(`Duplicate plan step id: ${step.id}`);
      }
      ids.add(step.id);
    }
  }

  private buildFallbackPatchRequests(task: TaskContext): RuntimePatchRequest[] {
    return task.plan?.steps
      .filter((step) => step.targetFiles.length > 0)
      .map((step) => ({
        description: step.description,
        targetPath: step.targetFiles[0]!,
        insertion: `\n// ${step.description}`,
      })) ?? [];
  }

  private async buildPatchPlan(task: TaskContext, requests: RuntimePatchRequest[]): Promise<PatchPlan> {
    const changeRequests = requests.map((request) => ({
      targetPath: request.targetPath,
      description: request.description,
      range: request.range,
      replacement: request.replacement,
      insertion: request.insertion,
    } satisfies ChangeRequest));

    const patches = await Promise.all(changeRequests.map((request) => this.patchEngine.buildPatchFromRequest(request)));
    const impact = patches.reduce(
      (acc, patch) => {
        acc.filesAffected.add(patch.targetPath);
        for (const hunk of patch.hunks) {
          acc.linesAdded += hunk.addedLines.length;
          acc.linesRemoved += hunk.removedLines.length;
        }
        return acc;
      },
      {
        filesAffected: new Set<string>(),
        linesAdded: 0,
        linesRemoved: 0,
      }
    );

    return {
      id: `runtime-plan-${task.id}-${task.attempts}`,
      createdAt: now(),
      patches,
      impact: {
        filesAffected: impact.filesAffected.size,
        linesAdded: impact.linesAdded,
        linesRemoved: impact.linesRemoved,
        riskLevel: impact.linesAdded + impact.linesRemoved > 200 ? 'high' : impact.linesAdded + impact.linesRemoved > 50 ? 'medium' : 'low',
      },
    };
  }

  private recordPatchArtifacts(task: TaskContext, patchPlan: PatchPlan, patchResult: PatchResult): void {
    task.artifacts.push({
      id: `patch-plan-${patchPlan.id}`,
      type: 'patch',
      path: `runtime/${task.id}/patch-plan.json`,
      content: JSON.stringify({
        id: patchPlan.id,
        patchCount: patchPlan.patches.length,
        impact: patchPlan.impact,
        success: patchResult.success,
      }, null, 2),
      metadata: {
        patchCount: patchPlan.patches.length,
        appliedCount: patchResult.applied.length,
        canRollback: patchResult.canRollback,
      },
    });

    for (const patch of patchPlan.patches) {
      task.artifacts.push({
        id: `patch-${patch.id}`,
        type: 'patch',
        path: patch.targetPath,
        metadata: {
          patchId: patch.id,
          targetPath: patch.targetPath,
        },
      });
    }
  }

  private recordBuildTestArtifacts(task: TaskContext, result: LoopRunResult): void {
    task.artifacts.push({
      id: `build-test-${task.id}-${task.attempts}`,
      type: 'log',
      path: `runtime/${task.id}/build-test.log`,
      content: result.output,
      metadata: {
        success: result.success,
        retries: result.retries,
        prePatchPassed: result.prePatchPassed,
        postPatchPassed: result.postPatchPassed,
      },
    });
  }

  private async rollbackTaskArtifacts(task: TaskContext): Promise<void> {
    const patchArtifacts = task.artifacts.filter((artifact) => artifact.type === 'patch');
    for (const artifact of [...patchArtifacts].reverse()) {
      const patchId = artifact.metadata?.patchId;
      if (typeof patchId === 'string') {
        await this.patchEngine.rollbackPatch(patchId);
      }
    }
  }

  private async initializeRepoState(): Promise<void> {
    this.repoIndex = this.repoScanner.getIndex?.() ?? null;
    if (!this.repoIndex) {
      await this.refreshRepoScan({ force: true });
    }
  }

  private async refreshRepoScan(options: { force?: boolean; paths?: string[] } = {}): Promise<void> {
    const result = await this.repoScanner.scan(options);
    this.repoScanResult = result;
    this.repoIndex = result.index ?? this.repoScanner.getIndex?.() ?? null;
  }

  private async refreshRepoAfterChanges(changedFiles: string[]): Promise<void> {
    const normalized = changedFiles
      .map((file) => path.isAbsolute(file) ? path.relative(this.config.repoRoot, file) : file)
      .filter(Boolean);

    if (normalized.length === 0) {
      await this.refreshRepoScan({ force: true });
      return;
    }

    if (this.repoScanner.scanIncremental) {
      const index = await this.repoScanner.scanIncremental(normalized.map((file) => ({ path: file, type: 'modified' as const })));
      this.repoIndex = index ?? this.repoScanner.getIndex?.() ?? this.repoIndex;
      this.repoScanResult = {
        success: true,
        index: this.repoIndex ?? undefined,
        filesProcessed: this.repoIndex?.files.size ?? 0,
        durationMs: 0,
        errors: [],
      };
      return;
    }

    await this.refreshRepoScan({ force: true, paths: normalized });
  }

  private classifyFailure(error: unknown): ClassifiedFailure {
    if (this.repairer?.classifyError) {
      return this.repairer.classifyError(error);
    }

    const reason = error instanceof Error ? error.message : String(error);
    const normalized = reason.toLowerCase();

    let category: ClassifiedFailure['category'] = 'unknown';
    if (normalized.includes('timeout')) {
      category = 'transient';
    } else if (normalized.includes('invalid') || normalized.includes('required') || normalized.includes('syntax')) {
      category = 'permanent';
    } else if (normalized.includes('memory') || normalized.includes('loop') || normalized.includes('safety')) {
      category = 'safety';
    } else if (normalized.includes('rate limit') || normalized.includes('econn') || normalized.includes('retry')) {
      category = 'transient';
    }

    return {
      category,
      error,
      reason,
      timestamp: now(),
      retryable: category === 'transient' || category === 'unknown',
    };
  }

  private getSessionTaskId(task: TaskContext): string {
    const sessionTaskId = task.metadata.sessionTaskId;
    return typeof sessionTaskId === 'string' && sessionTaskId.trim() ? sessionTaskId : task.id;
  }

  private mapFailureCategory(category: ClassifiedFailure['category']): ErrorClassification {
    switch (category) {
      case 'transient':
        return 'transient';
      case 'permanent':
        return 'permanent';
      case 'safety':
        return 'safety';
      default:
        return 'unknown';
    }
  }

  private mapPriorityToRoutePriority(priority: TaskPriority): RoutePriority {
    switch (priority) {
      case 'critical':
        return 'critical';
      case 'high':
        return 'high';
      default:
        return 'normal';
    }
  }

  private makeErrorLog(
    state: RuntimeTaskState,
    message: string,
    recoverable: boolean,
    classification: ErrorClassification,
    details?: Record<string, unknown>
  ): ErrorLog {
    return {
      timestamp: now(),
      state,
      message,
      recoverable,
      classification,
      details,
    };
  }

  private emit<K extends keyof RuntimeEventMap>(event: K, payload: RuntimeEventMap[K]): void {
    this.events.emit(event, payload);
  }

  private persistIfNeeded(): void {
    if (this.config.autoPersist) {
      this.persist();
    }
  }

  private mustGetTask(id: string): TaskContext {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    return task;
  }

  private serializeTask(task: TaskContext): PersistedTaskContext {
    return {
      ...cloneTask(task),
      handoff: task.handoff ? this.serializeHandoff(task.handoff) : undefined,
    };
  }

  private deserializeTask(task: PersistedTaskContext): TaskContext {
    return {
      ...task,
      handoff: task.handoff ? this.deserializeHandoff(task.handoff) : undefined,
    };
  }

  private serializeHandoff(payload: HandoffPayload): SerializableHandoffPayload {
    return {
      ...payload,
      timestamp: payload.timestamp.toISOString(),
      currentTask: {
        ...payload.currentTask,
        createdAt: payload.currentTask.createdAt.toISOString(),
        updatedAt: payload.currentTask.updatedAt.toISOString(),
      },
      taskStack: payload.taskStack.map((task) => ({
        ...task,
        createdAt: task.createdAt.toISOString(),
        updatedAt: task.updatedAt.toISOString(),
      })),
    };
  }

  private deserializeHandoff(payload: SerializableHandoffPayload): HandoffPayload {
    return {
      ...payload,
      timestamp: new Date(payload.timestamp),
      currentTask: {
        ...payload.currentTask,
        createdAt: new Date(payload.currentTask.createdAt),
        updatedAt: new Date(payload.currentTask.updatedAt),
      },
      taskStack: payload.taskStack.map((task) => ({
        ...task,
        createdAt: new Date(task.createdAt),
        updatedAt: new Date(task.updatedAt),
      })),
    };
  }
}

function normalizeSessionAdapter(adapter: SessionContextAdapter | SessionManager): SessionContextAdapter {
  const candidate = adapter as SessionManager & SessionContextAdapter;
  return {
    createSession: candidate.createSession
      ? (rootGoal: string, memoryPath?: string) => candidate.createSession!({ rootGoal, memoryPath })
      : undefined,
    getSession: candidate.getSession ? (sessionId: string) => candidate.getSession!(sessionId) : undefined,
    pushTask: candidate.pushTask
      ? (sessionId: string, goal: string, options?: { metadata?: Record<string, unknown>; status?: 'pending' | 'in-progress' | 'completed' | 'blocked' | 'failed' }) =>
          candidate.pushTask!(sessionId, goal, options)
      : undefined,
    restoreCheckpoint: candidate.restoreCheckpoint
      ? (sessionId: string, checkpointIdOrTag: string) => candidate.restoreCheckpoint!(sessionId, checkpointIdOrTag)
      : undefined,
    setScannerSnapshot: candidate.setScannerSnapshot
      ? (sessionId: string, snapshot: unknown) => candidate.setScannerSnapshot!(sessionId, snapshot)
      : undefined,
    updateTaskStatus: candidate.updateTaskStatus
      ? (sessionId: string, taskId: string, status) => candidate.updateTaskStatus!(sessionId, taskId, status)
      : undefined,
    prepareHandoff: candidate.prepareHandoff
      ? (sessionId, fromModel, toModel, relevantFiles, expectedActions) =>
          candidate.prepareHandoff!(sessionId, fromModel, toModel, relevantFiles, expectedActions)
      : undefined,
    createCheckpoint: candidate.createCheckpoint
      ? async (sessionId: string, files: string[], options?: { tag?: string; notes?: string; auto?: boolean }) =>
          candidate.createCheckpoint!(sessionId, files, options)
      : undefined,
  };
}

export const runtime = new RuntimeStateMachine();

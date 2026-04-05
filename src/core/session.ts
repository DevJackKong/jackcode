/**
 * Session Context Manager
 * Thread 02: Manages session state, task context, checkpoints, handoffs, persistence,
 * memory integration, and model usage tracking.
 */

import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ContextCompressor, estimateTokens } from '../repo/context-compressor.ts';
import type { ContextFragment } from '../types/context.ts';
import type { Patch } from '../types/patch.ts';
import type { FileIndex } from '../types/scanner.ts';
import type { RunResult } from '../types/test-runner.ts';
import type {
  Checkpoint,
  CheckpointCreateOptions,
  ContextCompressionResult,
  GoalNode,
  HandoffPayload,
  MemorySyncDetails,
  ModelUsage,
  ModelUsageTotals,
  RuntimeQueueSnapshot,
  RuntimeTaskSnapshot,
  Session,
  SessionContextSelection,
  SessionCreateOptions,
  SessionEvents,
  SessionPatchRecord,
  SessionPersistenceConfig,
  SessionRecoveryResult,
  SessionRepoSnapshotRecord,
  SessionSnapshot,
  SessionState,
  SessionTestResultRecord,
  SessionContextWindow,
  TaskContext,
  TaskCreateOptions,
  TaskStatus,
} from '../types/session.ts';
import type { JackClawMemoryAdapter, MemoryEntryType, SyncResult } from '../types/memory-adapter.ts';

type EventHandler<T> = (payload: T) => void;

type RuntimeLike = {
  on?: (event: string, handler: (payload: unknown) => void) => void;
  off?: (event: string, handler: (payload: unknown) => void) => void;
  getQueue?: () => Array<Record<string, unknown>>;
  getActiveTask?: () => Record<string, unknown> | undefined;
};

const DEFAULT_CONTEXT_WINDOW: SessionContextWindow = {
  maxTokens: 128000,
  warningThreshold: 0.75,
  compressionThreshold: 0.9,
  currentTokens: 0,
  lastCompressedAt: null,
};

const DEFAULT_MEMORY_ENTRY_TYPES: MemoryEntryType[] = [
  'decision',
  'learning',
  'context',
  'checkpoint',
  'error',
];

interface SerializedContextFragment {
  id: string;
  type: ContextFragment['type'];
  content: string;
  source?: string;
  timestamp: number;
  tokenCount?: number;
  metadata: ContextFragment['metadata'];
}

interface SerializedTaskContext {
  id: string;
  parentId: string | null;
  goal: string;
  criteria: string[];
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string | null;
  metadata: Record<string, unknown>;
  notes: string[];
  contextFragments: SerializedContextFragment[];
}

interface SerializedGoalNode {
  id: string;
  parentId: string | null;
  taskId: string | null;
  title: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  children: string[];
}

interface SerializedModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  latencyMs?: number;
  success: boolean;
  taskId?: string;
  timestamp: string;
}

interface SerializedSessionContextWindow {
  maxTokens: number;
  warningThreshold: number;
  compressionThreshold: number;
  currentTokens: number;
  lastCompressedAt: string | null;
}

interface SerializedCheckpoint {
  id: string;
  sessionId: string;
  tag: string | null;
  timestamp: string;
  fileHashes: Array<[string, string]>;
  cursorPositions: Array<[string, { line: number; column: number }]>
  taskContextId: string;
  notes: string;
  auto: boolean;
  snapshot: SerializedSessionSnapshot;
}

interface SerializedRuntimeTaskSnapshot {
  id: string;
  state: string;
  status: string;
  intent: string;
  priority?: string;
  updatedAt?: number;
}

interface SerializedRuntimeQueueSnapshot {
  activeTaskId: string | null;
  queue: SerializedRuntimeTaskSnapshot[];
  activeTask: SerializedRuntimeTaskSnapshot | null;
  lastSyncedAt: string | null;
}

interface SerializedSessionPatchRecord {
  id: string;
  file: string;
  patch: Patch;
  taskId: string | null;
  version: number;
  timestamp: string;
}

interface SerializedSessionTestResultRecord {
  id: string;
  taskId: string | null;
  timestamp: string;
  result: RunResult;
}

interface SerializedSessionRepoSnapshotRecord {
  snapshot: SerializedFileIndex;
  updatedAt: string;
}

interface SerializedSessionSnapshot {
  state: SessionState;
  currentTaskId: string | null;
  taskStack: SerializedTaskContext[];
  goalTree: SerializedGoalNode[];
  contextFragments: SerializedContextFragment[];
  modelUsage: SerializedModelUsage[];
  contextWindow: SerializedSessionContextWindow;
  metadata: Record<string, unknown>;
}

interface SerializedFileIndex {
  rootDir: string;
  files: Array<[string, unknown]>;
  directories: Array<[string, unknown]>;
  languages: Array<[string, unknown]>;
  generatedAt: number;
  gitInfo?: unknown;
  [key: string]: unknown;
}

interface SerializedSession {
  id: string;
  state: SessionState;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  rootGoal: string;
  taskStack: SerializedTaskContext[];
  currentTaskId: string | null;
  tasks: SerializedTaskContext[];
  goalTree: SerializedGoalNode[];
  checkpoints: SerializedCheckpoint[];
  modelUsage: SerializedModelUsage[];
  memoryPath: string | null;
  parentSessionId: string | null;
  metadata: Record<string, unknown>;
  contextFragments: SerializedContextFragment[];
  contextWindow: SerializedSessionContextWindow;
  lastMemorySyncAt: string | null;
  runtimeQueue: SerializedRuntimeQueueSnapshot;
  patchHistory: SerializedSessionPatchRecord[];
  fileVersions: Record<string, number>;
  testResults: SerializedSessionTestResultRecord[];
  repoSnapshot: SerializedSessionRepoSnapshotRecord | null;
  recoveryState: {
    recoveredFromCheckpointId: string | null;
    recoveredAt: string | null;
  };
}

class EventEmitter<T extends Record<string, unknown>> {
  private listeners: { [K in keyof T]?: EventHandler<T[K]>[] } = {};

  on<K extends keyof T>(event: K, handler: EventHandler<T[K]>): void {
    const existing = this.listeners[event] ?? [];
    existing.push(handler);
    this.listeners[event] = existing;
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    const handlers = this.listeners[event] ?? [];
    for (const handler of handlers) {
      handler(payload);
    }
  }
}

export interface SessionManagerOptions {
  persistence?: SessionPersistenceConfig;
  memoryAdapter?: JackClawMemoryAdapter;
}

export class SessionManager {
  private sessions = new Map<string, Session>();
  private events = new EventEmitter<SessionEvents>();
  private persistence: Required<SessionPersistenceConfig>;
  private memoryAdapter?: JackClawMemoryAdapter;
  private compressor = new ContextCompressor();

  constructor(options: SessionManagerOptions = {}) {
    this.persistence = {
      baseDir: options.persistence?.baseDir ?? '.jackcode/sessions',
      autoSave: options.persistence?.autoSave ?? false,
    };
    this.memoryAdapter = options.memoryAdapter;
  }

  on<K extends keyof SessionEvents>(event: K, handler: (payload: SessionEvents[K]) => void): void {
    this.events.on(event, handler);
  }

  createSession(options: SessionCreateOptions): Session {
    const rootGoal = options.rootGoal.trim();
    if (!rootGoal) throw new Error('rootGoal is required');

    const now = new Date();
    const rootTaskId = randomUUID();
    const rootGoalId = randomUUID();
    const rootTask: TaskContext = {
      id: rootTaskId,
      parentId: null,
      goal: rootGoal,
      criteria: [],
      status: 'in-progress',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      metadata: options.parentSessionId ? { parentSessionId: options.parentSessionId } : {},
      notes: [],
      contextFragments: [],
    };

    const rootGoalNode: GoalNode = {
      id: rootGoalId,
      parentId: null,
      taskId: rootTaskId,
      title: rootGoal,
      status: 'in-progress',
      createdAt: now,
      updatedAt: now,
      children: [],
    };

    const session: Session = {
      id: randomUUID(),
      state: 'created',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      rootGoal,
      taskStack: [rootTask],
      currentTask: rootTask,
      tasks: [rootTask],
      goalTree: [rootGoalNode],
      checkpoints: [],
      modelUsage: [],
      memoryPath: options.memoryPath ?? null,
      parentSessionId: options.parentSessionId ?? null,
      metadata: { ...(options.metadata ?? {}) },
      contextFragments: [],
      contextWindow: this.buildContextWindow(options.contextWindow),
      lastMemorySyncAt: null,
      runtimeQueue: {
        activeTaskId: null,
        queue: [],
        activeTask: null,
        lastSyncedAt: null,
      },
      patchHistory: [],
      fileVersions: {},
      testResults: [],
      repoSnapshot: null,
      recoveryState: {
        recoveredFromCheckpointId: null,
        recoveredAt: null,
      },
    };

    this.bindSessionMethods(session);
    this.sessions.set(session.id, session);
    this.events.emit('session-created', { session: this.cloneSession(session) });
    this.setState(session, 'active');
    this.touchSession(session, 'session-initialized');
    this.events.emit('task-start', { sessionId: session.id, task: this.cloneTask(rootTask) });
    return this.cloneSession(session);
  }

  getSession(id: string): Session | undefined {
    const session = this.sessions.get(id);
    return session ? this.cloneSession(session) : undefined;
  }

  listSessions(): Session[] {
    return Array.from(this.sessions.values()).map((session) => this.cloneSession(session));
  }

  attachToRuntime(sessionId: string, runtime: unknown): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const runtimeLike = runtime as RuntimeLike;

    const sync = () => {
      const queue = (runtimeLike.getQueue?.() ?? []).map((task) => this.toRuntimeTaskSnapshot(task));
      const activeTaskRaw = runtimeLike.getActiveTask?.();
      const activeTask = activeTaskRaw ? this.toRuntimeTaskSnapshot(activeTaskRaw) : null;
      session.runtimeQueue = {
        activeTaskId: activeTask?.id ?? null,
        queue,
        activeTask,
        lastSyncedAt: new Date(),
      };
      this.touchSession(session, 'runtime-synced');
      this.events.emit('runtime-updated', { sessionId, runtimeQueue: this.cloneRuntimeQueue(session.runtimeQueue) });
    };

    for (const event of ['task-created', 'task-enqueued', 'task-started', 'state-changed', 'task-completed', 'task-failed', 'task-cancelled', 'queue-drained', 'task-restored']) {
      runtimeLike.on?.(event, sync);
    }

    sync();
    this.events.emit('runtime-attached', { sessionId });
    return true;
  }

  addPatch(sessionId: string, file: string, patch: Patch): SessionPatchRecord | null {
    const session = this.sessions.get(sessionId);
    const normalizedFile = file.trim();
    if (!session || !normalizedFile) return null;

    const version = (session.fileVersions[normalizedFile] ?? 0) + 1;
    session.fileVersions[normalizedFile] = version;
    const record: SessionPatchRecord = {
      id: randomUUID(),
      file: normalizedFile,
      patch: structuredClone(patch),
      taskId: session.currentTask?.id ?? null,
      version,
      timestamp: new Date(),
    };
    session.patchHistory.push(record);

    if (session.repoSnapshot) {
      const cloned = this.cloneFileIndex(session.repoSnapshot.snapshot);
      cloned.generatedAt = Date.now();
      const existing = cloned.files.get(normalizedFile) as Record<string, unknown> | undefined;
      if (existing) {
        cloned.files.set(normalizedFile, {
          ...existing,
          modifiedAt: Date.now(),
        });
      }
      session.repoSnapshot = { snapshot: cloned, updatedAt: new Date() };
    }

    this.touchSession(session, 'patch-added');
    this.events.emit('patch-added', { sessionId, patch: this.clonePatchRecord(record) });
    return this.clonePatchRecord(record);
  }

  addTestResult(sessionId: string, result: RunResult): SessionTestResultRecord | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const record: SessionTestResultRecord = {
      id: randomUUID(),
      taskId: session.currentTask?.id ?? null,
      timestamp: new Date(),
      result: structuredClone(result),
    };
    session.testResults.push(record);

    const task = session.currentTask;
    if (task) {
      const history = Array.isArray(task.metadata.testHistory) ? task.metadata.testHistory as unknown[] : [];
      task.metadata.testHistory = [...history, structuredClone(result)];
      task.updatedAt = new Date();
      this.events.emit('task-update', { sessionId, task: this.cloneTask(task) });
    }

    this.touchSession(session, 'test-result-added');
    this.events.emit('test-result-added', { sessionId, result: this.cloneTestResult(record) });
    return this.cloneTestResult(record);
  }

  setRepoSnapshot(sessionId: string, snapshot: FileIndex): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.repoSnapshot = {
      snapshot: this.cloneFileIndex(snapshot),
      updatedAt: new Date(),
    };
    this.touchSession(session, 'repo-snapshot-updated');
    this.events.emit('repo-snapshot-updated', { sessionId, snapshot: this.cloneRepoSnapshot(session.repoSnapshot) });
    return true;
  }

  selectContext(sessionId: string, budget: number): SessionContextSelection | null {
    const session = this.sessions.get(sessionId);
    if (!session || budget <= 0) return null;

    if (this.shouldCompressContext(sessionId) || session.contextWindow.currentTokens > budget) {
      this.compressContext(sessionId, budget);
    }

    const sorted = [...session.contextFragments].sort((a, b) => {
      const priorityDelta = (b.metadata.priority ?? 0) - (a.metadata.priority ?? 0);
      if (priorityDelta !== 0) return priorityDelta;
      return (b.timestamp ?? 0) - (a.timestamp ?? 0);
    });

    const selected: ContextFragment[] = [];
    let totalTokens = 0;
    for (const fragment of sorted) {
      const tokenCount = fragment.tokenCount ?? estimateTokens(fragment.content);
      if (selected.length > 0 && totalTokens + tokenCount > budget) continue;
      if (selected.length === 0 && tokenCount > budget) {
        selected.push(this.cloneFragment(fragment));
        totalTokens += tokenCount;
        break;
      }
      if (totalTokens + tokenCount <= budget) {
        selected.push(this.cloneFragment(fragment));
        totalTokens += tokenCount;
      }
    }

    return {
      fragments: selected,
      totalTokens,
      truncated: selected.length < session.contextFragments.length,
    };
  }

  closeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state === 'closed') return false;

    const now = new Date();
    session.closedAt = now;
    if (session.currentTask && session.currentTask.status === 'in-progress') {
      session.currentTask.status = 'completed';
      session.currentTask.completedAt = now;
      session.currentTask.updatedAt = now;
    }
    this.setState(session, 'closed');
    this.events.emit('session-closed', { session: this.cloneSession(session) });
    return true;
  }

  pauseSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'active') return false;
    this.setState(session, 'paused');
    return true;
  }

  resumeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'paused') return false;
    this.setState(session, 'active');
    return true;
  }

  setErrorState(id: string, error: Error): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.events.emit('error', { sessionId: id, error });
    this.setState(session, 'error');
    return true;
  }

  pushTask(sessionId: string, goal: string, options: TaskCreateOptions = {}): TaskContext | null {
    const session = this.sessions.get(sessionId);
    const normalizedGoal = goal.trim();
    if (!session || session.state !== 'active' || !normalizedGoal) return null;

    const now = new Date();
    const parentTaskId = session.currentTask?.id ?? null;
    const task: TaskContext = {
      id: randomUUID(),
      parentId: parentTaskId,
      goal: normalizedGoal,
      criteria: [...(options.criteria ?? [])],
      status: options.status ?? 'in-progress',
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      metadata: { ...(options.metadata ?? {}) },
      notes: [...(options.notes ?? [])],
      contextFragments: [],
    };

    session.taskStack.push(task);
    session.tasks.push(task);
    session.currentTask = task;

    const goalNode: GoalNode = {
      id: randomUUID(),
      parentId: this.findGoalNodeByTaskId(session, parentTaskId)?.id ?? session.goalTree[0]?.id ?? null,
      taskId: task.id,
      title: normalizedGoal,
      status: task.status,
      createdAt: now,
      updatedAt: now,
      children: [],
    };
    session.goalTree.push(goalNode);
    if (goalNode.parentId) {
      const parentNode = session.goalTree.find((node) => node.id === goalNode.parentId);
      if (parentNode && !parentNode.children.includes(goalNode.id)) {
        parentNode.children.push(goalNode.id);
        parentNode.updatedAt = now;
      }
    }

    this.touchSession(session, 'task-pushed');
    this.events.emit('task-push', { sessionId, task: this.cloneTask(task) });
    this.events.emit('task-start', { sessionId, task: this.cloneTask(task) });
    return this.cloneTask(task);
  }

  popTask(sessionId: string): TaskContext | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'active' || session.taskStack.length <= 1) return null;

    const task = session.taskStack.pop();
    if (!task) return null;

    const now = new Date();
    task.status = 'completed';
    task.completedAt = now;
    task.updatedAt = now;
    this.updateGoalNodeStatus(session, task.id, 'completed', now);

    session.currentTask = session.taskStack.at(-1) ?? null;
    this.touchSession(session, 'task-popped');
    this.events.emit('task-pop', { sessionId, task: this.cloneTask(task) });
    this.events.emit('task-complete', { sessionId, task: this.cloneTask(task) });
    return this.cloneTask(task);
  }

  completeTask(sessionId: string, taskId: string): boolean {
    return this.updateTaskStatus(sessionId, taskId, 'completed');
  }

  failTask(sessionId: string, taskId: string, error?: string): boolean {
    const updated = this.updateTaskStatus(sessionId, taskId, 'failed');
    if (!updated) return false;

    const session = this.sessions.get(sessionId);
    const task = session?.tasks.find((candidate) => candidate.id === taskId);
    if (!session || !task) return false;

    this.events.emit('task-fail', { sessionId, task: this.cloneTask(task), error });
    if (error) {
      task.notes.push(`FAILURE: ${error}`);
      this.touchSession(session, 'task-failed');
    }
    return true;
  }

  updateTaskStatus(sessionId: string, taskId: string, status: TaskStatus): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const task = session.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;

    const now = new Date();
    task.status = status;
    task.updatedAt = now;
    task.completedAt = status === 'completed' || status === 'failed' ? now : null;
    this.updateGoalNodeStatus(session, taskId, status, now);
    this.touchSession(session, 'task-status-updated');
    this.events.emit('task-update', { sessionId, task: this.cloneTask(task) });
    if (status === 'completed') this.events.emit('task-complete', { sessionId, task: this.cloneTask(task) });
    return true;
  }

  getTaskStack(sessionId: string): TaskContext[] {
    const session = this.sessions.get(sessionId);
    return session ? session.taskStack.map((task) => this.cloneTask(task)) : [];
  }

  getGoalHierarchy(sessionId: string): GoalNode[] {
    const session = this.sessions.get(sessionId);
    return session ? session.goalTree.map((node) => this.cloneGoalNode(node)) : [];
  }

  addTaskNote(sessionId: string, taskId: string, note: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !note.trim()) return false;

    const task = session.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return false;

    task.notes.push(note.trim());
    task.updatedAt = new Date();
    this.touchSession(session, 'task-note-added');
    this.events.emit('task-update', { sessionId, task: this.cloneTask(task) });
    return true;
  }

  addContextFragment(sessionId: string, fragment: ContextFragment, taskId?: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const normalizedFragment = this.normalizeFragment(fragment);
    session.contextFragments.push(normalizedFragment);
    session.contextWindow.currentTokens = this.calculateTokens(session.contextFragments);

    const targetTask = taskId ? session.tasks.find((candidate) => candidate.id === taskId) : session.currentTask;
    if (targetTask) {
      targetTask.contextFragments.push(normalizedFragment);
      targetTask.updatedAt = new Date();
      this.events.emit('task-update', { sessionId, task: this.cloneTask(targetTask) });
    }

    if (this.shouldCompressContext(sessionId)) {
      this.compressContext(sessionId);
    } else {
      this.touchSession(session, 'context-fragment-added');
    }
    return true;
  }

  addContextFragments(sessionId: string, fragments: ContextFragment[], taskId?: string): number {
    let added = 0;
    for (const fragment of fragments) {
      if (this.addContextFragment(sessionId, fragment, taskId)) added += 1;
    }
    return added;
  }

  getContextFragments(sessionId: string): ContextFragment[] {
    const session = this.sessions.get(sessionId);
    return session ? session.contextFragments.map((fragment) => this.cloneFragment(fragment)) : [];
  }

  getContextWindow(sessionId: string): SessionContextWindow | null {
    const session = this.sessions.get(sessionId);
    return session ? this.cloneContextWindow(session.contextWindow) : null;
  }

  shouldCompressContext(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    const ratio = session.contextWindow.maxTokens > 0 ? session.contextWindow.currentTokens / session.contextWindow.maxTokens : 0;
    return ratio >= session.contextWindow.compressionThreshold;
  }

  compressContext(sessionId: string, targetBudget?: number): ContextCompressionResult | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const beforeTokens = session.contextWindow.currentTokens;
    const packed = this.compressor.pack(session.contextFragments);
    const compressed = this.compressor.compress(
      packed,
      targetBudget ?? Math.floor(session.contextWindow.maxTokens * session.contextWindow.warningThreshold),
    );

    session.contextFragments = compressed.fragments.map((fragment) => this.normalizeFragment(fragment));
    session.contextWindow.currentTokens = compressed.stats.finalTokens;
    session.contextWindow.lastCompressedAt = new Date(compressed.compressedAt);

    const result: ContextCompressionResult = {
      triggered: beforeTokens > compressed.stats.finalTokens,
      beforeTokens,
      afterTokens: compressed.stats.finalTokens,
      compressedContext: compressed,
      droppedFragments: compressed.stats.fragmentsDropped,
    };

    this.touchSession(session, 'context-compressed');
    this.events.emit('context-compressed', { sessionId, result });
    return result;
  }

  async createCheckpoint(sessionId: string, files: string[], options: CheckpointCreateOptions = {}): Promise<Checkpoint | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.currentTask) return null;

    const fileHashes = new Map<string, string>();
    const cursorPositions = new Map<string, { line: number; column: number }>();
    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        fileHashes.set(filePath, createHash('sha256').update(content).digest('hex'));
      } catch {
        continue;
      }
      const cursor = options.cursorPositions?.[filePath] ?? { line: 1, column: 1 };
      cursorPositions.set(filePath, { ...cursor });
    }

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      sessionId,
      tag: options.tag ?? null,
      timestamp: new Date(),
      fileHashes,
      cursorPositions,
      taskContextId: session.currentTask.id,
      notes: options.notes ?? '',
      auto: options.auto ?? false,
      snapshot: this.createSnapshot(session),
    };

    session.checkpoints.push(checkpoint);
    this.touchSession(session, 'checkpoint-created');
    this.events.emit('checkpoint-created', { sessionId, checkpoint: this.cloneCheckpoint(checkpoint) });
    return this.cloneCheckpoint(checkpoint);
  }

  getCheckpoints(sessionId: string): Checkpoint[] {
    const session = this.sessions.get(sessionId);
    return session ? session.checkpoints.map((checkpoint) => this.cloneCheckpoint(checkpoint)) : [];
  }

  findCheckpoint(sessionId: string, tag: string): Checkpoint | undefined {
    const session = this.sessions.get(sessionId);
    const checkpoint = session?.checkpoints.find((candidate) => candidate.tag === tag);
    return checkpoint ? this.cloneCheckpoint(checkpoint) : undefined;
  }

  restoreCheckpoint(sessionId: string, checkpointIdOrTag: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const checkpoint = session.checkpoints.find((candidate) => candidate.id === checkpointIdOrTag || candidate.tag === checkpointIdOrTag);
    if (!checkpoint) return false;

    this.applySnapshot(session, checkpoint.snapshot);
    session.recoveryState.recoveredFromCheckpointId = checkpoint.id;
    session.recoveryState.recoveredAt = new Date();
    this.touchSession(session, 'checkpoint-restored');
    this.events.emit('checkpoint-restored', { sessionId, checkpoint: this.cloneCheckpoint(checkpoint) });
    return true;
  }

  prepareHandoff(
    sessionId: string,
    fromModel: string,
    toModel: string,
    relevantFiles: Array<{ path: string; content: string; relevance: 'high' | 'medium' | 'low' }>,
    expectedActions: string[],
  ): HandoffPayload | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.currentTask) return null;

    const progress = session.tasks.filter((task) => task.status === 'completed').map((task) => task.goal);
    const blockers = session.tasks.filter((task) => task.status === 'blocked' || task.status === 'failed').map((task) => task.goal);

    const payload: HandoffPayload = {
      sessionId,
      summary: [
        `Root goal: ${session.rootGoal}`,
        `Current task: ${session.currentTask.goal}`,
        progress.length > 0 ? `Completed: ${progress.join('; ')}` : 'Completed: none yet',
        blockers.length > 0 ? `Blockers: ${blockers.join('; ')}` : 'Blockers: none',
      ].join(' | '),
      progress,
      blockers,
      decisions: this.extractDecisions(session),
      currentTask: this.cloneTask(session.currentTask),
      taskStack: session.taskStack.map((task) => this.cloneTask(task)),
      relevantFiles,
      expectedActions: [...expectedActions],
      fromModel,
      toModel,
      timestamp: new Date(),
      compressedContext: this.shouldCompressContext(sessionId)
        ? this.compressor.compress(this.compressor.pack(session.contextFragments), Math.floor(session.contextWindow.maxTokens * session.contextWindow.warningThreshold))
        : undefined,
    };

    this.events.emit('handoff-prepared', { sessionId, payload });
    return payload;
  }

  recordModelUsage(
    sessionId: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    cost: number,
    options: { latencyMs?: number; success?: boolean; taskId?: string } = {},
  ): boolean {
    const session = this.sessions.get(sessionId);
    const metrics = [tokensIn, tokensOut, cost, options.latencyMs ?? 0];
    if (!session || metrics.some((value) => !Number.isFinite(value) || value < 0) || !model.trim()) return false;

    const usage: ModelUsage = {
      model: model.trim(),
      tokensIn,
      tokensOut,
      totalTokens: tokensIn + tokensOut,
      cost,
      latencyMs: options.latencyMs,
      success: options.success ?? true,
      taskId: options.taskId,
      timestamp: new Date(),
    };

    session.modelUsage.push(usage);
    this.touchSession(session, 'model-usage-recorded');
    return true;
  }

  getModelUsage(sessionId: string): ModelUsage[] {
    const session = this.sessions.get(sessionId);
    return session ? session.modelUsage.map((usage) => this.cloneModelUsage(usage)) : [];
  }

  getModelUsageTotals(sessionId: string): ModelUsageTotals {
    const usage = this.sessions.get(sessionId)?.modelUsage ?? [];
    const totals: ModelUsageTotals = {
      totalTokensIn: 0,
      totalTokensOut: 0,
      totalTokens: 0,
      totalCost: 0,
      averageLatencyMs: 0,
      successRate: 0,
      byModel: {},
    };

    let latencyCount = 0;
    let successCount = 0;
    for (const item of usage) {
      totals.totalTokensIn += item.tokensIn;
      totals.totalTokensOut += item.tokensOut;
      totals.totalTokens += item.totalTokens;
      totals.totalCost += item.cost;
      if (item.success) successCount += 1;
      if (typeof item.latencyMs === 'number') {
        totals.averageLatencyMs += item.latencyMs;
        latencyCount += 1;
      }
      const bucket = totals.byModel[item.model] ?? { calls: 0, tokensIn: 0, tokensOut: 0, totalTokens: 0, cost: 0, averageLatencyMs: 0, successRate: 0 };
      bucket.calls += 1;
      bucket.tokensIn += item.tokensIn;
      bucket.tokensOut += item.tokensOut;
      bucket.totalTokens += item.totalTokens;
      bucket.cost += item.cost;
      if (typeof item.latencyMs === 'number') bucket.averageLatencyMs += item.latencyMs;
      if (item.success) bucket.successRate += 1;
      totals.byModel[item.model] = bucket;
    }

    totals.averageLatencyMs = latencyCount > 0 ? totals.averageLatencyMs / latencyCount : 0;
    totals.successRate = usage.length > 0 ? successCount / usage.length : 0;
    for (const bucket of Object.values(totals.byModel)) {
      bucket.averageLatencyMs = bucket.calls > 0 ? bucket.averageLatencyMs / bucket.calls : 0;
      bucket.successRate = bucket.calls > 0 ? bucket.successRate / bucket.calls : 0;
    }
    return totals;
  }

  getTotalCost(sessionId: string): number {
    return this.getModelUsageTotals(sessionId).totalCost;
  }

  saveSession(sessionId: string): string | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    const filePath = this.getSessionFilePath(sessionId);
    mkdirSync(this.persistence.baseDir, { recursive: true });
    writeFileSync(filePath, JSON.stringify(this.serializeSession(session), null, 2), 'utf-8');
    return filePath;
  }

  recoverSession(sessionId: string): SessionRecoveryResult | null {
    const filePath = this.getSessionFilePath(sessionId);
    if (!existsSync(filePath)) return null;
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as SerializedSession;
    const session = this.deserializeSession(raw);
    this.sessions.set(session.id, session);
    this.touchSession(session, 'session-recovered');
    return { session: this.cloneSession(session), source: 'persistence' };
  }

  async pushMemory(sessionId: string, options: { tags?: string[]; types?: MemoryEntryType[] } = {}): Promise<MemorySyncDetails | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.memoryAdapter) return null;

    const fragments = this.buildMemoryFragments(session, options.tags ?? [], options.types ?? DEFAULT_MEMORY_ENTRY_TYPES);
    const result = await this.memoryAdapter.push(fragments, sessionId);
    session.lastMemorySyncAt = new Date(result.timestamp);
    this.touchSession(session, 'memory-pushed');
    const details: MemorySyncDetails = { result };
    this.events.emit('memory-synced', { sessionId, details });
    return details;
  }

  async pullMemory(sessionId: string, options: { tags?: string[]; types?: MemoryEntryType[]; since?: number; limit?: number } = {}): Promise<MemorySyncDetails | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.memoryAdapter) return null;

    const entries = await this.memoryAdapter.pull({ sessionId, tags: options.tags, types: options.types, since: options.since, limit: options.limit });
    this.addContextFragments(sessionId, entries);

    const result: SyncResult = {
      mode: 'pull',
      pulled: entries.length,
      pushed: 0,
      conflicts: 0,
      errors: [],
      timestamp: Date.now(),
    };
    session.lastMemorySyncAt = new Date(result.timestamp);
    this.touchSession(session, 'memory-pulled');
    const details: MemorySyncDetails = { result };
    this.events.emit('memory-synced', { sessionId, details });
    return details;
  }

  private bindSessionMethods(session: Session): void {
    session.attachToRuntime = (runtime: unknown) => {
      this.attachToRuntime(session.id, runtime);
    };
    session.addPatch = (file: string, patch: Patch) => this.addPatch(session.id, file, patch);
    session.addTestResult = (result: RunResult) => this.addTestResult(session.id, result);
    session.setRepoSnapshot = (snapshot: FileIndex) => {
      this.setRepoSnapshot(session.id, snapshot);
    };
    session.selectContext = (budget: number) => this.selectContext(session.id, budget) ?? { fragments: [], totalTokens: 0, truncated: false };
  }

  private buildMemoryFragments(session: Session, tags: string[], types: MemoryEntryType[]): ContextFragment[] {
    const now = Date.now();
    const sharedTags = Array.from(new Set(['session', ...tags]));
    const fragments: ContextFragment[] = [];

    if (types.includes('decision')) {
      for (const decision of this.extractDecisions(session)) {
        fragments.push({
          id: randomUUID(),
          type: 'system',
          content: `${decision.decision}\nReason: ${decision.reason}`,
          source: `session:${session.id}`,
          timestamp: now,
          metadata: { accessCount: 0, lastAccess: now, priority: 0.9, tags: [...sharedTags, 'decision'] },
        });
      }
    }

    if (types.includes('learning')) {
      for (const task of session.tasks) {
        for (const note of task.notes) {
          fragments.push({
            id: randomUUID(),
            type: 'doc',
            content: note,
            source: `task:${task.id}`,
            timestamp: now,
            metadata: { accessCount: 0, lastAccess: now, priority: 0.6, tags: [...sharedTags, 'learning'] },
          });
        }
      }
    }

    if (types.includes('context')) {
      fragments.push(...session.contextFragments.map((fragment) => ({
        ...this.cloneFragment(fragment),
        metadata: { ...fragment.metadata, tags: Array.from(new Set([...fragment.metadata.tags, ...sharedTags, 'context'])) },
      })));
    }

    if (types.includes('checkpoint')) {
      for (const checkpoint of session.checkpoints) {
        fragments.push({
          id: randomUUID(),
          type: 'system',
          content: `Checkpoint ${checkpoint.tag ?? checkpoint.id}: ${checkpoint.notes}`,
          source: `checkpoint:${checkpoint.id}`,
          timestamp: checkpoint.timestamp.getTime(),
          metadata: {
            accessCount: 0,
            lastAccess: checkpoint.timestamp.getTime(),
            priority: checkpoint.auto ? 0.5 : 0.75,
            tags: [...sharedTags, 'checkpoint'],
          },
        });
      }
    }

    if (types.includes('error')) {
      for (const task of session.tasks.filter((candidate) => candidate.status === 'failed')) {
        fragments.push({
          id: randomUUID(),
          type: 'error',
          content: task.notes.at(-1) ?? `Task failed: ${task.goal}`,
          source: `task:${task.id}`,
          timestamp: now,
          metadata: { accessCount: 0, lastAccess: now, priority: 1, tags: [...sharedTags, 'error'] },
        });
      }
    }

    return fragments;
  }

  private extractDecisions(session: Session): Array<{ timestamp: Date; decision: string; reason: string }> {
    const decisions: Array<{ timestamp: Date; decision: string; reason: string }> = [];
    for (const task of session.tasks) {
      for (const note of task.notes) {
        if (note.toLowerCase().startsWith('decision:')) {
          const content = note.slice('decision:'.length).trim();
          const [decision, ...reasonParts] = content.split('|');
          decisions.push({
            timestamp: task.updatedAt,
            decision: decision.trim(),
            reason: reasonParts.join('|').trim() || 'No reason captured',
          });
        }
      }
    }
    return decisions;
  }

  private createSnapshot(session: Session): SessionSnapshot {
    return {
      state: session.state,
      currentTaskId: session.currentTask?.id ?? null,
      taskStack: session.taskStack.map((task) => this.cloneTask(task)),
      goalTree: session.goalTree.map((node) => this.cloneGoalNode(node)),
      contextFragments: session.contextFragments.map((fragment) => this.cloneFragment(fragment)),
      modelUsage: session.modelUsage.map((usage) => this.cloneModelUsage(usage)),
      contextWindow: this.cloneContextWindow(session.contextWindow),
      metadata: structuredClone(session.metadata),
    };
  }

  private applySnapshot(session: Session, snapshot: SessionSnapshot): void {
    session.state = snapshot.state;
    session.taskStack = snapshot.taskStack.map((task) => this.cloneTask(task));
    session.tasks = this.mergeTasks(session.tasks, session.taskStack);
    session.goalTree = snapshot.goalTree.map((node) => this.cloneGoalNode(node));
    session.contextFragments = snapshot.contextFragments.map((fragment) => this.cloneFragment(fragment));
    session.modelUsage = snapshot.modelUsage.map((usage) => this.cloneModelUsage(usage));
    session.contextWindow = this.cloneContextWindow(snapshot.contextWindow);
    session.metadata = structuredClone(snapshot.metadata);
    session.currentTask = session.taskStack.find((task) => task.id === snapshot.currentTaskId) ?? null;
  }

  private mergeTasks(existing: TaskContext[], fromStack: TaskContext[]): TaskContext[] {
    const merged = new Map<string, TaskContext>();
    for (const task of existing) merged.set(task.id, this.cloneTask(task));
    for (const task of fromStack) merged.set(task.id, this.cloneTask(task));
    return Array.from(merged.values());
  }

  private buildContextWindow(partial?: Partial<SessionContextWindow>): SessionContextWindow {
    return {
      ...DEFAULT_CONTEXT_WINDOW,
      ...(partial ?? {}),
      maxTokens: partial?.maxTokens && partial.maxTokens > 0 ? partial.maxTokens : DEFAULT_CONTEXT_WINDOW.maxTokens,
      warningThreshold: partial?.warningThreshold ?? DEFAULT_CONTEXT_WINDOW.warningThreshold,
      compressionThreshold: partial?.compressionThreshold ?? DEFAULT_CONTEXT_WINDOW.compressionThreshold,
      currentTokens: partial?.currentTokens ?? 0,
      lastCompressedAt: partial?.lastCompressedAt ?? null,
    };
  }

  private normalizeFragment(fragment: ContextFragment): ContextFragment {
    return {
      ...fragment,
      tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content),
      metadata: {
        accessCount: fragment.metadata.accessCount,
        lastAccess: fragment.metadata.lastAccess,
        priority: fragment.metadata.priority,
        tags: [...fragment.metadata.tags],
      },
    };
  }

  private calculateTokens(fragments: ContextFragment[]): number {
    return fragments.reduce((sum, fragment) => sum + (fragment.tokenCount ?? estimateTokens(fragment.content)), 0);
  }

  private toRuntimeTaskSnapshot(task: Record<string, unknown>): RuntimeTaskSnapshot {
    return {
      id: String(task.id ?? ''),
      state: String(task.state ?? 'unknown'),
      status: String(task.status ?? 'unknown'),
      intent: String(task.intent ?? ''),
      priority: typeof task.priority === 'string' ? task.priority : undefined,
      updatedAt: typeof task.updatedAt === 'number' ? task.updatedAt : undefined,
    };
  }

  private findGoalNodeByTaskId(session: Session, taskId: string | null): GoalNode | undefined {
    return session.goalTree.find((node) => node.taskId === taskId);
  }

  private updateGoalNodeStatus(session: Session, taskId: string, status: TaskStatus, when: Date): void {
    const node = this.findGoalNodeByTaskId(session, taskId);
    if (!node) return;
    node.status = status;
    node.updatedAt = when;
  }

  private touchSession(session: Session, reason: string): void {
    session.updatedAt = new Date();
    if (this.persistence.autoSave) this.saveSession(session.id);
    this.events.emit('session-updated', { session: this.cloneSession(session), reason });
  }

  private setState(session: Session, newState: SessionState): void {
    const oldState = session.state;
    if (oldState === newState) return;
    session.state = newState;
    this.touchSession(session, `state:${oldState}->${newState}`);
    this.events.emit('state-change', { sessionId: session.id, from: oldState, to: newState });
  }

  private getSessionFilePath(sessionId: string): string {
    return join(this.persistence.baseDir, `${sessionId}.json`);
  }

  private serializeSession(session: Session): SerializedSession {
    return {
      id: session.id,
      state: session.state,
      createdAt: session.createdAt.toISOString(),
      updatedAt: session.updatedAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
      rootGoal: session.rootGoal,
      taskStack: session.taskStack.map((task) => this.serializeTask(task)),
      currentTaskId: session.currentTask?.id ?? null,
      tasks: session.tasks.map((task) => this.serializeTask(task)),
      goalTree: session.goalTree.map((node) => this.serializeGoalNode(node)),
      checkpoints: session.checkpoints.map((checkpoint) => this.serializeCheckpoint(checkpoint)),
      modelUsage: session.modelUsage.map((usage) => this.serializeModelUsage(usage)),
      memoryPath: session.memoryPath,
      parentSessionId: session.parentSessionId,
      metadata: structuredClone(session.metadata),
      contextFragments: session.contextFragments.map((fragment) => this.serializeFragment(fragment)),
      contextWindow: this.serializeContextWindow(session.contextWindow),
      lastMemorySyncAt: session.lastMemorySyncAt?.toISOString() ?? null,
      runtimeQueue: this.serializeRuntimeQueue(session.runtimeQueue),
      patchHistory: session.patchHistory.map((record) => this.serializePatchRecord(record)),
      fileVersions: { ...session.fileVersions },
      testResults: session.testResults.map((record) => this.serializeTestResult(record)),
      repoSnapshot: session.repoSnapshot ? this.serializeRepoSnapshot(session.repoSnapshot) : null,
      recoveryState: {
        recoveredFromCheckpointId: session.recoveryState.recoveredFromCheckpointId,
        recoveredAt: session.recoveryState.recoveredAt?.toISOString() ?? null,
      },
    };
  }

  private deserializeSession(raw: SerializedSession): Session {
    const tasks = raw.tasks.map((task) => this.deserializeTask(task));
    const taskMap = new Map(tasks.map((task) => [task.id, task]));
    const taskStack = raw.taskStack.map((task) => taskMap.get(task.id) ?? this.deserializeTask(task));

    const session: Session = {
      id: raw.id,
      state: raw.state,
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
      closedAt: raw.closedAt ? new Date(raw.closedAt) : null,
      rootGoal: raw.rootGoal,
      taskStack,
      currentTask: raw.currentTaskId ? taskMap.get(raw.currentTaskId) ?? null : null,
      tasks,
      goalTree: raw.goalTree.map((node) => this.deserializeGoalNode(node)),
      checkpoints: raw.checkpoints.map((checkpoint) => this.deserializeCheckpoint(checkpoint)),
      modelUsage: raw.modelUsage.map((usage) => this.deserializeModelUsage(usage)),
      memoryPath: raw.memoryPath,
      parentSessionId: raw.parentSessionId,
      metadata: structuredClone(raw.metadata),
      contextFragments: raw.contextFragments.map((fragment) => this.deserializeFragment(fragment)),
      contextWindow: this.deserializeContextWindow(raw.contextWindow),
      lastMemorySyncAt: raw.lastMemorySyncAt ? new Date(raw.lastMemorySyncAt) : null,
      runtimeQueue: this.deserializeRuntimeQueue(raw.runtimeQueue),
      patchHistory: raw.patchHistory.map((record) => this.deserializePatchRecord(record)),
      fileVersions: { ...(raw.fileVersions ?? {}) },
      testResults: raw.testResults.map((record) => this.deserializeTestResult(record)),
      repoSnapshot: raw.repoSnapshot ? this.deserializeRepoSnapshot(raw.repoSnapshot) : null,
      recoveryState: {
        recoveredFromCheckpointId: raw.recoveryState.recoveredFromCheckpointId,
        recoveredAt: raw.recoveryState.recoveredAt ? new Date(raw.recoveryState.recoveredAt) : null,
      },
    };
    this.bindSessionMethods(session);
    return session;
  }

  private serializeTask(task: TaskContext): SerializedTaskContext {
    return {
      id: task.id,
      parentId: task.parentId,
      goal: task.goal,
      criteria: [...task.criteria],
      status: task.status,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
      completedAt: task.completedAt?.toISOString() ?? null,
      metadata: structuredClone(task.metadata),
      notes: [...task.notes],
      contextFragments: task.contextFragments.map((fragment) => this.serializeFragment(fragment)),
    };
  }

  private deserializeTask(raw: SerializedTaskContext): TaskContext {
    return {
      id: raw.id,
      parentId: raw.parentId,
      goal: raw.goal,
      criteria: [...raw.criteria],
      status: raw.status,
      createdAt: new Date(raw.createdAt),
      updatedAt: new Date(raw.updatedAt),
      completedAt: raw.completedAt ? new Date(raw.completedAt) : null,
      metadata: structuredClone(raw.metadata),
      notes: [...raw.notes],
      contextFragments: raw.contextFragments.map((fragment) => this.deserializeFragment(fragment)),
    };
  }

  private serializeGoalNode(node: GoalNode): SerializedGoalNode {
    return { ...node, createdAt: node.createdAt.toISOString(), updatedAt: node.updatedAt.toISOString(), children: [...node.children] };
  }

  private deserializeGoalNode(raw: SerializedGoalNode): GoalNode {
    return { ...raw, createdAt: new Date(raw.createdAt), updatedAt: new Date(raw.updatedAt), children: [...raw.children] };
  }

  private serializeModelUsage(usage: ModelUsage): SerializedModelUsage {
    return { ...usage, timestamp: usage.timestamp.toISOString() };
  }

  private deserializeModelUsage(raw: SerializedModelUsage): ModelUsage {
    return { ...raw, timestamp: new Date(raw.timestamp) };
  }

  private serializeFragment(fragment: ContextFragment): SerializedContextFragment {
    return { ...fragment, metadata: { ...fragment.metadata, tags: [...fragment.metadata.tags] } };
  }

  private deserializeFragment(raw: SerializedContextFragment): ContextFragment {
    return { ...raw, metadata: { ...raw.metadata, tags: [...raw.metadata.tags] } };
  }

  private serializeContextWindow(window: SessionContextWindow): SerializedSessionContextWindow {
    return { ...window, lastCompressedAt: window.lastCompressedAt?.toISOString() ?? null };
  }

  private deserializeContextWindow(raw: SerializedSessionContextWindow): SessionContextWindow {
    return { ...raw, lastCompressedAt: raw.lastCompressedAt ? new Date(raw.lastCompressedAt) : null };
  }

  private serializeCheckpoint(checkpoint: Checkpoint): SerializedCheckpoint {
    return {
      id: checkpoint.id,
      sessionId: checkpoint.sessionId,
      tag: checkpoint.tag,
      timestamp: checkpoint.timestamp.toISOString(),
      fileHashes: Array.from(checkpoint.fileHashes.entries()),
      cursorPositions: Array.from(checkpoint.cursorPositions.entries()).map(([path, value]) => [path, { ...value }]),
      taskContextId: checkpoint.taskContextId,
      notes: checkpoint.notes,
      auto: checkpoint.auto,
      snapshot: this.serializeSnapshot(checkpoint.snapshot),
    };
  }

  private deserializeCheckpoint(raw: SerializedCheckpoint): Checkpoint {
    return {
      id: raw.id,
      sessionId: raw.sessionId,
      tag: raw.tag,
      timestamp: new Date(raw.timestamp),
      fileHashes: new Map(raw.fileHashes),
      cursorPositions: new Map(raw.cursorPositions.map(([path, value]) => [path, { ...value }])),
      taskContextId: raw.taskContextId,
      notes: raw.notes,
      auto: raw.auto,
      snapshot: this.deserializeSnapshot(raw.snapshot),
    };
  }

  private serializeSnapshot(snapshot: SessionSnapshot): SerializedSessionSnapshot {
    return {
      state: snapshot.state,
      currentTaskId: snapshot.currentTaskId,
      taskStack: snapshot.taskStack.map((task) => this.serializeTask(task)),
      goalTree: snapshot.goalTree.map((node) => this.serializeGoalNode(node)),
      contextFragments: snapshot.contextFragments.map((fragment) => this.serializeFragment(fragment)),
      modelUsage: snapshot.modelUsage.map((usage) => this.serializeModelUsage(usage)),
      contextWindow: this.serializeContextWindow(snapshot.contextWindow),
      metadata: structuredClone(snapshot.metadata),
    };
  }

  private deserializeSnapshot(raw: SerializedSessionSnapshot): SessionSnapshot {
    return {
      state: raw.state,
      currentTaskId: raw.currentTaskId,
      taskStack: raw.taskStack.map((task) => this.deserializeTask(task)),
      goalTree: raw.goalTree.map((node) => this.deserializeGoalNode(node)),
      contextFragments: raw.contextFragments.map((fragment) => this.deserializeFragment(fragment)),
      modelUsage: raw.modelUsage.map((usage) => this.deserializeModelUsage(usage)),
      contextWindow: this.deserializeContextWindow(raw.contextWindow),
      metadata: structuredClone(raw.metadata),
    };
  }

  private serializeRuntimeQueue(runtimeQueue: RuntimeQueueSnapshot): SerializedRuntimeQueueSnapshot {
    return {
      activeTaskId: runtimeQueue.activeTaskId,
      queue: runtimeQueue.queue.map((task) => ({ ...task })),
      activeTask: runtimeQueue.activeTask ? { ...runtimeQueue.activeTask } : null,
      lastSyncedAt: runtimeQueue.lastSyncedAt?.toISOString() ?? null,
    };
  }

  private deserializeRuntimeQueue(raw: SerializedRuntimeQueueSnapshot): RuntimeQueueSnapshot {
    return {
      activeTaskId: raw.activeTaskId,
      queue: raw.queue.map((task) => ({ ...task })),
      activeTask: raw.activeTask ? { ...raw.activeTask } : null,
      lastSyncedAt: raw.lastSyncedAt ? new Date(raw.lastSyncedAt) : null,
    };
  }

  private serializePatchRecord(record: SessionPatchRecord): SerializedSessionPatchRecord {
    return { ...record, patch: structuredClone(record.patch), timestamp: record.timestamp.toISOString() };
  }

  private deserializePatchRecord(raw: SerializedSessionPatchRecord): SessionPatchRecord {
    return { ...raw, patch: structuredClone(raw.patch), timestamp: new Date(raw.timestamp) };
  }

  private serializeTestResult(record: SessionTestResultRecord): SerializedSessionTestResultRecord {
    return { ...record, result: structuredClone(record.result), timestamp: record.timestamp.toISOString() };
  }

  private deserializeTestResult(raw: SerializedSessionTestResultRecord): SessionTestResultRecord {
    return { ...raw, result: structuredClone(raw.result), timestamp: new Date(raw.timestamp) };
  }

  private serializeRepoSnapshot(snapshot: SessionRepoSnapshotRecord): SerializedSessionRepoSnapshotRecord {
    return { snapshot: this.serializeFileIndex(snapshot.snapshot), updatedAt: snapshot.updatedAt.toISOString() };
  }

  private deserializeRepoSnapshot(raw: SerializedSessionRepoSnapshotRecord): SessionRepoSnapshotRecord {
    return { snapshot: this.deserializeFileIndex(raw.snapshot), updatedAt: new Date(raw.updatedAt) };
  }

  private serializeFileIndex(index: FileIndex): SerializedFileIndex {
    const raw = index as FileIndex & Record<string, unknown>;
    return {
      ...raw,
      rootDir: index.rootDir,
      files: Array.from(index.files.entries()),
      directories: Array.from(index.directories.entries()),
      languages: Array.from(index.languages.entries()),
      generatedAt: index.generatedAt,
      gitInfo: raw.gitInfo,
    };
  }

  private deserializeFileIndex(raw: SerializedFileIndex): FileIndex {
    return {
      ...(raw as Record<string, unknown>),
      rootDir: raw.rootDir,
      files: new Map(raw.files) as FileIndex['files'],
      directories: new Map(raw.directories) as FileIndex['directories'],
      languages: new Map(raw.languages) as FileIndex['languages'],
      generatedAt: raw.generatedAt,
      gitInfo: raw.gitInfo as FileIndex['gitInfo'],
    };
  }

  private cloneSession(session: Session): Session {
    return this.deserializeSession(this.serializeSession(session));
  }
  private cloneTask(task: TaskContext): TaskContext { return this.deserializeTask(this.serializeTask(task)); }
  private cloneGoalNode(node: GoalNode): GoalNode { return this.deserializeGoalNode(this.serializeGoalNode(node)); }
  private cloneModelUsage(usage: ModelUsage): ModelUsage { return this.deserializeModelUsage(this.serializeModelUsage(usage)); }
  private cloneCheckpoint(checkpoint: Checkpoint): Checkpoint { return this.deserializeCheckpoint(this.serializeCheckpoint(checkpoint)); }
  private cloneFragment(fragment: ContextFragment): ContextFragment { return this.deserializeFragment(this.serializeFragment(fragment)); }
  private cloneContextWindow(window: SessionContextWindow): SessionContextWindow { return this.deserializeContextWindow(this.serializeContextWindow(window)); }
  private cloneRuntimeQueue(runtimeQueue: RuntimeQueueSnapshot): RuntimeQueueSnapshot { return this.deserializeRuntimeQueue(this.serializeRuntimeQueue(runtimeQueue)); }
  private clonePatchRecord(record: SessionPatchRecord): SessionPatchRecord { return this.deserializePatchRecord(this.serializePatchRecord(record)); }
  private cloneTestResult(record: SessionTestResultRecord): SessionTestResultRecord { return this.deserializeTestResult(this.serializeTestResult(record)); }
  private cloneRepoSnapshot(snapshot: SessionRepoSnapshotRecord): SessionRepoSnapshotRecord { return this.deserializeRepoSnapshot(this.serializeRepoSnapshot(snapshot)); }
  private cloneFileIndex(index: FileIndex): FileIndex { return this.deserializeFileIndex(this.serializeFileIndex(index)); }
}

export const sessionManager = new SessionManager();

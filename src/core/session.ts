/**
 * Session Context Manager
 * Thread 02: Manages session state, task context, checkpoints, and handoffs
 */

import { randomUUID } from 'crypto';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import type {
  Session,
  SessionState,
  TaskContext,
  Checkpoint,
  HandoffPayload,
  ModelUsage,
  SessionCreateOptions,
  CheckpointCreateOptions,
  SessionEvents,
} from '../types/session.js';

// Simple event emitter for session events
class EventEmitter<T extends Record<string, unknown>> {
  private listeners: Map<keyof T, Array<(payload: unknown) => void>> = new Map();

  on<K extends keyof T>(event: K, handler: (payload: T[K]) => void): void {
    const existing = this.listeners.get(event) || [];
    existing.push(handler as (payload: unknown) => void);
    this.listeners.set(event, existing);
  }

  emit<K extends keyof T>(event: K, payload: T[K]): void {
    const handlers = this.listeners.get(event) || [];
    handlers.forEach((h) => h(payload));
  }
}

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private events: EventEmitter<SessionEvents> = new EventEmitter();

  // Event subscription
  on<K extends keyof SessionEvents>(
    event: K,
    handler: (payload: SessionEvents[K]) => void
  ): void {
    this.events.on(event, handler);
  }

  // Session lifecycle
  createSession(options: SessionCreateOptions): Session {
    const now = new Date();
    const rootTask: TaskContext = {
      id: randomUUID(),
      parentId: null,
      goal: options.rootGoal,
      criteria: [],
      status: 'in-progress',
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };

    const session: Session = {
      id: randomUUID(),
      state: 'created',
      createdAt: now,
      updatedAt: now,
      closedAt: null,
      taskStack: [rootTask],
      currentTask: rootTask,
      checkpoints: [],
      modelUsage: [],
      memoryPath: options.memoryPath || null,
    };

    this.sessions.set(session.id, session);
    this.setState(session, 'active');

    return session;
  }

  getSession(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  closeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    session.closedAt = new Date();
    this.setState(session, 'closed');
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

  // Task context management
  pushTask(
    sessionId: string,
    goal: string,
    criteria: string[] = []
  ): TaskContext | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'active') return null;

    const now = new Date();
    const task: TaskContext = {
      id: randomUUID(),
      parentId: session.currentTask?.id || null,
      goal,
      criteria,
      status: 'in-progress',
      createdAt: now,
      updatedAt: now,
      metadata: {},
    };

    session.taskStack.push(task);
    session.currentTask = task;
    session.updatedAt = now;

    this.events.emit('task-push', { task });
    return task;
  }

  popTask(sessionId: string): TaskContext | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'active') return null;
    if (session.taskStack.length <= 1) return null; // Keep root task

    const task = session.taskStack.pop()!;
    task.status = 'completed';
    task.updatedAt = new Date();

    session.currentTask = session.taskStack[session.taskStack.length - 1];
    session.updatedAt = new Date();

    this.events.emit('task-pop', { task });
    this.events.emit('task-complete', { task });
    return task;
  }

  updateTaskStatus(
    sessionId: string,
    taskId: string,
    status: TaskContext['status']
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const task = session.taskStack.find((t) => t.id === taskId);
    if (!task) return false;

    task.status = status;
    task.updatedAt = new Date();
    session.updatedAt = new Date();

    return true;
  }

  getTaskStack(sessionId: string): TaskContext[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.taskStack] : [];
  }

  // Checkpoint system
  async createCheckpoint(
    sessionId: string,
    files: string[],
    options: CheckpointCreateOptions = {}
  ): Promise<Checkpoint | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const fileHashes = new Map<string, string>();
    const cursorPositions = new Map<string, { line: number; column: number }>();

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        fileHashes.set(filePath, hash);
        cursorPositions.set(filePath, { line: 1, column: 1 }); // Default position
      } catch {
        // File doesn't exist or can't be read, skip
        continue;
      }
    }

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      sessionId,
      tag: options.tag || null,
      timestamp: new Date(),
      fileHashes,
      cursorPositions,
      taskContextId: session.currentTask?.id || '',
      notes: options.notes || '',
    };

    session.checkpoints.push(checkpoint);
    session.updatedAt = new Date();

    this.events.emit('checkpoint-created', { checkpoint });
    return checkpoint;
  }

  getCheckpoints(sessionId: string): Checkpoint[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.checkpoints] : [];
  }

  findCheckpoint(sessionId: string, tag: string): Checkpoint | undefined {
    const session = this.sessions.get(sessionId);
    return session?.checkpoints.find((c) => c.tag === tag);
  }

  // Handoff preparation for model switching
  prepareHandoff(
    sessionId: string,
    fromModel: string,
    toModel: string,
    relevantFiles: Array<{ path: string; content: string; relevance: 'high' | 'medium' | 'low' }>,
    expectedActions: string[]
  ): HandoffPayload | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.currentTask) return null;

    // Build progress summary from completed tasks
    const progress: string[] = [];
    const decisions: Array<{ timestamp: Date; decision: string; reason: string }> = [];

    for (const task of session.taskStack) {
      if (task.status === 'completed') {
        progress.push(task.goal);
      }
    }

    // Identify blockers
    const blockers = session.taskStack
      .filter((t) => t.status === 'blocked')
      .map((t) => t.goal);

    const payload: HandoffPayload = {
      sessionId,
      summary: `Session ${sessionId}: ${session.currentTask.goal}`,
      progress,
      blockers,
      decisions,
      currentTask: session.currentTask,
      taskStack: [...session.taskStack],
      relevantFiles,
      expectedActions,
      fromModel,
      toModel,
      timestamp: new Date(),
    };

    this.events.emit('handoff-prepared', { payload });
    return payload;
  }

  // Model usage tracking
  recordModelUsage(
    sessionId: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    cost: number
  ): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const usage: ModelUsage = {
      model,
      tokensIn,
      tokensOut,
      cost,
      timestamp: new Date(),
    };

    session.modelUsage.push(usage);
    session.updatedAt = new Date();

    return true;
  }

  getModelUsage(sessionId: string): ModelUsage[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.modelUsage] : [];
  }

  getTotalCost(sessionId: string): number {
    const session = this.sessions.get(sessionId);
    return session?.modelUsage.reduce((sum, u) => sum + u.cost, 0) || 0;
  }

  // Private helpers
  private setState(session: Session, newState: SessionState): void {
    const oldState = session.state;
    session.state = newState;
    session.updatedAt = new Date();
    this.events.emit('state-change', { from: oldState, to: newState });
  }
}

// Singleton export for global session management
export const sessionManager = new SessionManager();

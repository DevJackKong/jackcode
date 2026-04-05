/**
 * Session Context Manager
 * Thread 02: Manages session state, task context, checkpoints, and handoffs
 */

import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

type EventHandler<T> = (payload: T) => void;

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

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private events: EventEmitter<SessionEvents> = new EventEmitter<SessionEvents>();

  on<K extends keyof SessionEvents>(
    event: K,
    handler: (payload: SessionEvents[K]) => void
  ): void {
    this.events.on(event, handler);
  }

  createSession(options: SessionCreateOptions): Session {
    const rootGoal = options.rootGoal.trim();
    if (!rootGoal) {
      throw new Error('rootGoal is required');
    }

    const now = new Date();
    const rootTask: TaskContext = {
      id: randomUUID(),
      parentId: null,
      goal: rootGoal,
      criteria: [],
      status: 'in-progress',
      createdAt: now,
      updatedAt: now,
      metadata: options.parentSessionId ? { parentSessionId: options.parentSessionId } : {},
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
      memoryPath: options.memoryPath ?? null,
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
    if (!session || session.state === 'closed') {
      return false;
    }

    session.closedAt = new Date();
    this.setState(session, 'closed');
    return true;
  }

  pauseSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'active') {
      return false;
    }

    this.setState(session, 'paused');
    return true;
  }

  resumeSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session || session.state !== 'paused') {
      return false;
    }

    this.setState(session, 'active');
    return true;
  }

  pushTask(
    sessionId: string,
    goal: string,
    criteria: string[] = []
  ): TaskContext | null {
    const session = this.sessions.get(sessionId);
    const normalizedGoal = goal.trim();
    if (!session || session.state !== 'active' || !normalizedGoal) {
      return null;
    }

    const now = new Date();
    const task: TaskContext = {
      id: randomUUID(),
      parentId: session.currentTask?.id ?? null,
      goal: normalizedGoal,
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
    if (!session || session.state !== 'active' || session.taskStack.length <= 1) {
      return null;
    }

    const task = session.taskStack.pop();
    if (!task) {
      return null;
    }

    task.status = 'completed';
    task.updatedAt = new Date();

    session.currentTask = session.taskStack.at(-1) ?? null;
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
    if (!session) {
      return false;
    }

    const task = session.taskStack.find((candidate) => candidate.id === taskId);
    if (!task) {
      return false;
    }

    task.status = status;
    task.updatedAt = new Date();
    session.updatedAt = new Date();
    return true;
  }

  getTaskStack(sessionId: string): TaskContext[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.taskStack] : [];
  }

  async createCheckpoint(
    sessionId: string,
    files: string[],
    options: CheckpointCreateOptions = {}
  ): Promise<Checkpoint | null> {
    const session = this.sessions.get(sessionId);
    if (!session || !session.currentTask) {
      return null;
    }

    const fileHashes = new Map<string, string>();
    const cursorPositions = new Map<string, { line: number; column: number }>();

    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const hash = createHash('sha256').update(content).digest('hex');
        fileHashes.set(filePath, hash);
        cursorPositions.set(filePath, { line: 1, column: 1 });
      } catch {
        continue;
      }
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
    return session?.checkpoints.find((checkpoint) => checkpoint.tag === tag);
  }

  prepareHandoff(
    sessionId: string,
    fromModel: string,
    toModel: string,
    relevantFiles: Array<{ path: string; content: string; relevance: 'high' | 'medium' | 'low' }>,
    expectedActions: string[]
  ): HandoffPayload | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.currentTask) {
      return null;
    }

    const progress = session.taskStack
      .filter((task) => task.status === 'completed')
      .map((task) => task.goal);

    const blockers = session.taskStack
      .filter((task) => task.status === 'blocked')
      .map((task) => task.goal);

    const payload: HandoffPayload = {
      sessionId,
      summary: `Session ${sessionId}: ${session.currentTask.goal}`,
      progress,
      blockers,
      decisions: [],
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

  recordModelUsage(
    sessionId: string,
    model: string,
    tokensIn: number,
    tokensOut: number,
    cost: number
  ): boolean {
    const session = this.sessions.get(sessionId);
    const metrics = [tokensIn, tokensOut, cost];
    if (!session || metrics.some((value) => !Number.isFinite(value) || value < 0)) {
      return false;
    }

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
    return session?.modelUsage.reduce((sum, usage) => sum + usage.cost, 0) ?? 0;
  }

  private setState(session: Session, newState: SessionState): void {
    const oldState = session.state;
    if (oldState === newState) {
      return;
    }

    session.state = newState;
    session.updatedAt = new Date();
    this.events.emit('state-change', { from: oldState, to: newState });
  }
}

export const sessionManager = new SessionManager();

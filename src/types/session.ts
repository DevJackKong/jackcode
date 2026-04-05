/**
 * Session Context Types
 * Thread 02: Session state, task context, checkpoints, and handoff
 */

import type { ContextFragment, CompressedContext } from './context.js';
import type {
  JackClawMemoryAdapter,
  MemoryEntry,
  MemoryEntryType,
  SyncResult,
} from './memory-adapter.js';

// Session lifecycle states
export type SessionState = 'created' | 'active' | 'paused' | 'error' | 'closed';

export type TaskStatus = 'pending' | 'in-progress' | 'completed' | 'blocked' | 'failed';

export interface SessionContextWindow {
  maxTokens: number;
  warningThreshold: number;
  compressionThreshold: number;
  currentTokens: number;
  lastCompressedAt: Date | null;
}

export interface TaskContext {
  id: string;
  parentId: string | null;
  goal: string;
  criteria: string[];
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date | null;
  metadata: Record<string, unknown>;
  notes: string[];
  contextFragments: ContextFragment[];
}

export interface GoalNode {
  id: string;
  parentId: string | null;
  taskId: string | null;
  title: string;
  status: TaskStatus;
  createdAt: Date;
  updatedAt: Date;
  children: string[];
}

export interface Checkpoint {
  id: string;
  sessionId: string;
  tag: string | null;
  timestamp: Date;
  fileHashes: Map<string, string>;
  cursorPositions: Map<string, { line: number; column: number }>;
  taskContextId: string;
  notes: string;
  auto: boolean;
  snapshot: SessionSnapshot;
}

export interface SessionSnapshot {
  state: SessionState;
  currentTaskId: string | null;
  taskStack: TaskContext[];
  goalTree: GoalNode[];
  contextFragments: ContextFragment[];
  modelUsage: ModelUsage[];
  contextWindow: SessionContextWindow;
  metadata: Record<string, unknown>;
}

export interface HandoffPayload {
  sessionId: string;
  summary: string;
  progress: string[];
  blockers: string[];
  decisions: Array<{ timestamp: Date; decision: string; reason: string }>;
  currentTask: TaskContext;
  taskStack: TaskContext[];
  relevantFiles: Array<{
    path: string;
    content: string;
    relevance: 'high' | 'medium' | 'low';
  }>;
  expectedActions: string[];
  fromModel: string;
  toModel: string;
  timestamp: Date;
  compressedContext?: CompressedContext;
}

export interface ModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
  cost: number;
  latencyMs?: number;
  success: boolean;
  taskId?: string;
  timestamp: Date;
}

export interface ModelUsageTotals {
  totalTokensIn: number;
  totalTokensOut: number;
  totalTokens: number;
  totalCost: number;
  averageLatencyMs: number;
  successRate: number;
  byModel: Record<
    string,
    {
      calls: number;
      tokensIn: number;
      tokensOut: number;
      totalTokens: number;
      cost: number;
      averageLatencyMs: number;
      successRate: number;
    }
  >;
}

export interface SessionPersistenceConfig {
  baseDir?: string;
  autoSave?: boolean;
}

export interface SessionMemoryConfig {
  adapter?: JackClawMemoryAdapter;
  autoSync?: boolean;
  tags?: string[];
  persistTypes?: MemoryEntryType[];
}

export interface Session {
  id: string;
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
  rootGoal: string;
  taskStack: TaskContext[];
  currentTask: TaskContext | null;
  tasks: TaskContext[];
  goalTree: GoalNode[];
  checkpoints: Checkpoint[];
  modelUsage: ModelUsage[];
  memoryPath: string | null;
  parentSessionId: string | null;
  metadata: Record<string, unknown>;
  contextFragments: ContextFragment[];
  contextWindow: SessionContextWindow;
  lastMemorySyncAt: Date | null;
  recoveryState: {
    recoveredFromCheckpointId: string | null;
    recoveredAt: Date | null;
  };
}

export interface SessionCreateOptions {
  rootGoal: string;
  memoryPath?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
  contextWindow?: Partial<SessionContextWindow>;
}

export interface CheckpointCreateOptions {
  tag?: string;
  notes?: string;
  auto?: boolean;
  cursorPositions?: Record<string, { line: number; column: number }>;
}

export interface TaskCreateOptions {
  criteria?: string[];
  metadata?: Record<string, unknown>;
  notes?: string[];
  status?: TaskStatus;
}

export interface SessionRecoveryResult {
  session: Session;
  source: 'persistence' | 'checkpoint';
}

export interface ContextCompressionResult {
  triggered: boolean;
  beforeTokens: number;
  afterTokens: number;
  compressedContext: CompressedContext | null;
  droppedFragments: number;
}

export interface MemorySyncDetails {
  result: SyncResult;
  entries?: MemoryEntry[];
}

export interface SessionEvents {
  'session-created': { session: Session };
  'session-updated': { session: Session; reason: string };
  'session-closed': { session: Session };
  'state-change': { sessionId: string; from: SessionState; to: SessionState };
  'task-start': { sessionId: string; task: TaskContext };
  'task-push': { sessionId: string; task: TaskContext };
  'task-pop': { sessionId: string; task: TaskContext };
  'task-update': { sessionId: string; task: TaskContext };
  'task-complete': { sessionId: string; task: TaskContext };
  'task-fail': { sessionId: string; task: TaskContext; error?: string };
  'checkpoint-created': { sessionId: string; checkpoint: Checkpoint };
  'checkpoint-restored': { sessionId: string; checkpoint: Checkpoint };
  'context-compressed': { sessionId: string; result: ContextCompressionResult };
  'memory-synced': { sessionId: string; details: MemorySyncDetails };
  'handoff-prepared': { sessionId: string; payload: HandoffPayload };
  error: { sessionId?: string; error: Error };
}

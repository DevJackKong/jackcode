/**
 * Session Context Types
 * Thread 02: Session state, task context, checkpoints, and handoff
 */

// Session lifecycle states
export type SessionState = 'created' | 'active' | 'paused' | 'error' | 'closed';

// Task context for hierarchical goal tracking
export interface TaskContext {
  id: string;
  parentId: string | null;
  goal: string;
  criteria: string[];  // Completion criteria
  status: 'pending' | 'in-progress' | 'completed' | 'blocked';
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}

// Lightweight checkpoint (hashes, not full copies)
export interface Checkpoint {
  id: string;
  sessionId: string;
  tag: string | null;
  timestamp: Date;
  fileHashes: Map<string, string>;  // path → hash
  cursorPositions: Map<string, { line: number; column: number }>;
  taskContextId: string;
  notes: string;
}

// Handoff payload for model switching
export interface HandoffPayload {
  // Session summary
  sessionId: string;
  summary: string;
  progress: string[];
  blockers: string[];
  decisions: Array<{ timestamp: Date; decision: string; reason: string }>;

  // Current context
  currentTask: TaskContext;
  taskStack: TaskContext[];  // Full hierarchy

  // Relevant context
  relevantFiles: Array<{
    path: string;
    content: string;
    relevance: 'high' | 'medium' | 'low';
  }>;

  // Next actions
  expectedActions: string[];

  // Metadata
  fromModel: string;
  toModel: string;
  timestamp: Date;
}

// Model usage tracking for cost control
export interface ModelUsage {
  model: string;
  tokensIn: number;
  tokensOut: number;
  cost: number;  // Estimated USD
  timestamp: Date;
}

// Main session interface
export interface Session {
  id: string;
  state: SessionState;
  createdAt: Date;
  updatedAt: Date;
  closedAt: Date | null;

  // Task hierarchy
  taskStack: TaskContext[];
  currentTask: TaskContext | null;

  // Checkpoints
  checkpoints: Checkpoint[];

  // Usage tracking
  modelUsage: ModelUsage[];

  // JackClaw integration
  memoryPath: string | null;
}

// Session creation options
export interface SessionCreateOptions {
  rootGoal: string;
  memoryPath?: string;
  parentSessionId?: string;  // For forking
}

// Checkpoint creation options
export interface CheckpointCreateOptions {
  tag?: string;
  notes?: string;
  auto?: boolean;  // Auto-created before destructive ops
}

// Events emitted by session manager
export interface SessionEvents {
  'state-change': { from: SessionState; to: SessionState };
  'task-push': { task: TaskContext };
  'task-pop': { task: TaskContext };
  'task-complete': { task: TaskContext };
  'checkpoint-created': { checkpoint: Checkpoint };
  'checkpoint-restored': { checkpoint: Checkpoint };
  'handoff-prepared': { payload: HandoffPayload };
  'error': { error: Error };
}

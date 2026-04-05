/**
 * JackClaw Collaboration Adapter Types
 * Thread 15: Subagent task delegation and result aggregation
 */

import type { ContextFragment } from '../../../types/context.js';
import type { Patch } from '../../../types/patch.js';

/**
 * Subagent task definition
 */
export interface SubagentTask {
  /** Unique task identifier */
  taskId: string;
  /** Parent session ID */
  sessionId: string;
  /** Task goal description */
  goal: string;
  /** Task context */
  context: SubagentContext;
  /** Expected output specification */
  expectedOutput: ExpectedOutput;
  /** Timeout in milliseconds */
  timeout: number;
  /** Priority 0-1 */
  priority: number;
  /** Task dependencies that must finish first */
  dependencies?: string[];
  /** Optional handoff preferences */
  handoff?: {
    allow?: boolean;
    resumeToken?: string;
    preferredNodeId?: string;
  };
}

/**
 * Context provided to subagent
 */
export interface SubagentContext {
  /** Relevant file paths */
  files: string[];
  /** Context fragments */
  fragments: ContextFragment[];
  /** Task constraints */
  constraints: string[];
  /** Parent session checkpoint (for restoration) */
  parentCheckpoint?: string;
}

/**
 * Expected output specification
 */
export interface ExpectedOutput {
  /** Output type */
  type: 'files' | 'analysis' | 'patch' | 'verification' | 'mixed';
  /** Output format hint */
  format: string;
  /** Specific file patterns expected */
  filePatterns?: string[];
}

/**
 * Subagent execution result
 */
export interface SubagentResult {
  /** Task ID */
  taskId: string;
  /** Subagent session ID */
  subagentId: string;
  /** Execution status */
  status: SubagentStatus;
  /** Output data */
  outputs: SubagentOutputs;
  /** Execution metrics */
  metrics: SubagentMetrics;
  /** Error messages if failed */
  errors?: string[];
}

/**
 * Subagent lifecycle status
 */
export type SubagentStatus =
  | 'pending'
  | 'running'
  | 'success'
  | 'failure'
  | 'timeout'
  | 'cancelled';

/**
 * Subagent output data variants
 */
export interface SubagentOutputs {
  /** Generated/modified files */
  files?: GeneratedFile[];
  /** Analysis text */
  analysis?: string;
  /** Code patch */
  patch?: Patch;
  /** Verification result */
  verification?: boolean;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Generated file entry
 */
export interface GeneratedFile {
  /** File path */
  path: string;
  /** File content */
  content: string;
  /** Whether this is a new file */
  isNew: boolean;
}

/**
 * Subagent execution metrics
 */
export interface SubagentMetrics {
  /** Start timestamp (ms) */
  startTime: number;
  /** End timestamp (ms) */
  endTime: number;
  /** Total tokens used */
  tokensUsed: number;
  /** Estimated cost (USD) */
  estimatedCost?: number;
  /** Node that completed the task */
  nodeId?: string;
  /** Attempt counter */
  attempt?: number;
}

export type CollaborationAdapterMetrics = SubagentMetrics;

/**
 * Handle to track a spawned subagent
 */
export interface SubagentHandle {
  /** Subagent session ID */
  id: string;
  /** Parent task ID */
  taskId: string;
  /** Current status */
  status: SubagentStatus;
  /** Creation timestamp */
  createdAt: number;
  /** Assigned node */
  assignedNodeId?: string;
  /** Task priority */
  priority?: number;
  /** Monotonic sequence number */
  sequence?: number;
}

/**
 * Subagent pool configuration
 */
export interface SubagentPoolConfig {
  /** Maximum concurrent subagents */
  maxConcurrent: number;
  /** Default timeout (ms) */
  defaultTimeout: number;
  /** Retry attempts for failed tasks */
  maxRetries: number;
  /** Cost budget (USD) */
  costBudget?: number;
  /** Node heartbeat timeout before suspect/offline */
  nodeHeartbeatTimeoutMs?: number;
  /** Timeout for deadlock detection / lock lease */
  deadlockTimeoutMs?: number;
  /** Message log retention */
  messageHistoryLimit?: number;
  /** Max concurrent tasks per node */
  maxTasksPerNode?: number;
  /** Whether work stealing is enabled */
  workStealing?: boolean;
}

/**
 * Aggregated result from multiple subagents
 */
export interface AggregatedResult {
  /** Individual results */
  results: SubagentResult[];
  /** Overall success status */
  allSuccess: boolean;
  /** Combined outputs */
  combined: {
    files: GeneratedFile[];
    analysis: string[];
    patches: Patch[];
    verifications: boolean[];
    metadata: Record<string, unknown>[];
  };
  /** Total metrics */
  totals: {
    duration: number;
    tokensUsed: number;
    estimatedCost: number;
  };
  /** Failed task IDs */
  failures: string[];
}

export type MessageOrderingMode = 'none' | 'per-channel' | 'global';
export type NodeSelectionReason = 'preferred' | 'least-loaded' | 'fallback';

export interface NodeAssignment {
  nodeId: string;
  capacity: number;
  loadScore?: number;
  labels?: string[];
  status?: 'online' | 'suspect' | 'offline';
  lastSeenAt?: number;
}

export interface CollaborationMessage {
  id: string;
  kind: 'direct' | 'broadcast';
  fromNodeId: string;
  recipients: string[];
  payload: Record<string, unknown>;
  timestamp: number;
  channel: string;
  ordering: MessageOrderingMode;
  sequence: number;
}

export interface DirectMessageOptions {
  channel?: string;
  ordering?: MessageOrderingMode;
}

export interface CoordinationLock {
  resourceId: string;
  ownerNodeId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface NodeConsensusState {
  taskId: string;
  participants: string[];
  approvals: string[];
  rejectedBy: string[];
  reached: boolean;
  decidedAt: number;
}

export interface HandoffStateSnapshot {
  taskId: string;
  progress: SubagentStatus;
  assignedNodeId: string;
  attempts: number;
  context: SubagentContext;
  metadata: Record<string, unknown>;
}

export interface TaskHandoffRecord {
  taskId: string;
  fromNodeId: string;
  toNodeId: string;
  transferredAt: number;
  reason: 'rebalancing' | 'node-failure' | 'manual' | 'work-steal';
  stateSnapshot: HandoffStateSnapshot;
  resumed: boolean;
}

export interface CollaborationNodeHealth {
  nodeId: string;
  status: 'online' | 'suspect' | 'offline';
  loadScore: number;
  capacity: number;
  activeTasks: number;
  assignedTasks: number;
  lastHeartbeatAt: number;
  averageLatencyMs: number;
  tokensUsed: number;
  handoffsIn: number;
  handoffsOut: number;
  stolenTasks: number;
}

export interface CollaborationMetricsSnapshot {
  activeTasks: number;
  queuedTasks: number;
  completedTasks: number;
  failedTasks: number;
  cancelledTasks: number;
  registeredNodes: number;
  suspectNodes: number;
  offlineNodes: number;
  messagesSent: number;
  handoffs: number;
  averageTaskLatencyMs: number;
}

export interface CollaborationTaskRecord {
  taskId: string;
  status: SubagentStatus;
  assignedNodeId: string;
  priority: number;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  attempts: number;
  dependencies: string[];
  handoffs: TaskHandoffRecord[];
  consensus?: NodeConsensusState;
}

/**
 * Task handoff event
 */
export interface TaskHandoffEvent {
  /** Event type */
  type: 'spawn' | 'complete' | 'fail' | 'cancel' | 'handoff';
  /** Timestamp */
  timestamp: number;
  /** Task handle */
  handle: SubagentHandle;
  /** Result (if completed) */
  result?: SubagentResult;
  /** Task ID */
  taskId?: string;
  /** Current node */
  nodeId?: string;
  /** Previous node */
  fromNodeId?: string;
  /** Handoff record */
  handoff?: TaskHandoffRecord;
}

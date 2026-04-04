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
  | 'pending'    // Waiting to start
  | 'running'    // Currently executing
  | 'success'    // Completed successfully
  | 'failure'    // Failed with errors
  | 'timeout'    // Exceeded time limit
  | 'cancelled'; // Manually cancelled

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
}

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

/**
 * Task handoff event
 */
export interface TaskHandoffEvent {
  /** Event type */
  type: 'spawn' | 'complete' | 'fail' | 'cancel';
  /** Timestamp */
  timestamp: number;
  /** Task handle */
  handle: SubagentHandle;
  /** Result (if completed) */
  result?: SubagentResult;
}

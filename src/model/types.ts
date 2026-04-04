/**
 * Thread 09: Qwen Executor Router Types
 * Primary executor model routing types
 */

import type { CompressedContext } from '../types/context.js';

/** Route priority levels */
export type RoutePriority = 'normal' | 'high' | 'critical';

/** Code operation types */
export type OperationType = 'edit' | 'create' | 'delete' | 'refactor';

/** Individual code operation */
export interface CodeOperation {
  id: string;
  type: OperationType;
  targetFile: string;
  description: string;
  dependencies: string[];
}

/** Completed operation with result */
export interface CompletedOperation extends CodeOperation {
  success: boolean;
  diff?: string;
  error?: string;
  latencyMs: number;
}

/** Escalation reasons */
export type EscalationReason =
  | 'timeout'
  | 'context_overflow'
  | 'syntax_error'
  | 'dependency_conflict'
  | 'max_retries_exceeded';

/** Route request to Qwen executor */
export interface QwenRouteRequest {
  taskId: string;
  context: CompressedContext;
  operations: CodeOperation[];
  priority: RoutePriority;
  timeoutMs: number;
}

/** Execution metrics */
export interface ExecutionMetrics {
  latencyMs: number;
  tokensUsed: number;
  cacheHitRatio: number;
  retryCount: number;
}

/** Route result from Qwen executor */
export interface QwenRouteResult {
  taskId: string;
  success: boolean;
  operations: CompletedOperation[];
  metrics: ExecutionMetrics;
  escalation?: EscalationReason;
}

/** Router performance metrics */
export interface RouterMetrics {
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  averageLatencyMs: number;
  currentLoad: number;
  maxConcurrency: number;
}

/** Execution slot for load balancing */
export interface ExecutionSlot {
  id: string;
  acquiredAt: number;
  expiresAt: number;
}

/** Router configuration */
export interface RouterConfig {
  maxConcurrency: number;
  maxBatchSize: number;
  defaultTimeoutMs: number;
  criticalTimeoutMs: number;
  enableBatching: boolean;
}

/** Default configuration */
export const DEFAULT_ROUTER_CONFIG: RouterConfig = {
  maxConcurrency: 3,
  maxBatchSize: 5,
  defaultTimeoutMs: 60000,
  criticalTimeoutMs: 180000,
  enableBatching: true,
};

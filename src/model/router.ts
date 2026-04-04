/**
 * Thread 09: Qwen Executor Router
 * Primary executor model router for JackCode
 */

import type {
  CodeOperation,
  CompletedOperation,
  EscalationReason,
  ExecutionMetrics,
  ExecutionSlot,
  QwenRouteRequest,
  QwenRouteResult,
  RouterConfig,
  RouterMetrics,
  RoutePriority,
} from './types.js';
import { DEFAULT_ROUTER_CONFIG } from './types.js';

/**
 * Qwen 3.6 Executor Router
 * Routes execution tasks to Qwen with load balancing and result aggregation
 */
export class QwenExecutorRouter {
  private config: RouterConfig;
  private activeSlots: Map<string, ExecutionSlot> = new Map();
  private metrics: RouterMetrics;
  private requestHistory: number[] = [];

  constructor(config: Partial<RouterConfig> = {}) {
    this.config = { ...DEFAULT_ROUTER_CONFIG, ...config };
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatencyMs: 0,
      currentLoad: 0,
      maxConcurrency: this.config.maxConcurrency,
    };
  }

  /**
   * Main entry point: route a task to Qwen executor
   */
  async route(request: QwenRouteRequest): Promise<QwenRouteResult> {
    const startTime = Date.now();
    this.metrics.totalRequests++;

    try {
      // Acquire execution slot
      const slot = await this.acquireSlot(request.priority);

      // Determine execution strategy
      const strategy = this.selectStrategy(request);

      // Execute based on strategy
      let result: QwenRouteResult;
      if (strategy === 'batch' && this.config.enableBatching) {
        result = await this.executeBatch(request, slot);
      } else {
        result = await this.executeSingle(request, slot);
      }

      // Update metrics
      this.updateMetrics(result.success, Date.now() - startTime);

      return result;
    } catch (error) {
      this.metrics.failedRequests++;
      return this.createErrorResult(request.taskId, error);
    }
  }

  /**
   * Batch route multiple requests
   */
  async batchRoute(requests: QwenRouteRequest[]): Promise<QwenRouteResult[]> {
    if (requests.length > this.config.maxBatchSize) {
      throw new Error(
        `Batch size ${requests.length} exceeds maximum ${this.config.maxBatchSize}`
      );
    }

    // Process with concurrency limit using semaphore pattern
    const results: QwenRouteResult[] = [];
    const executing: Promise<void>[] = [];

    for (const request of requests) {
      const promise = this.route(request).then((result) => {
        results.push(result);
      });
      executing.push(promise);

      // Wait for slot when at capacity
      if (executing.length >= this.config.maxConcurrency) {
        await Promise.race(executing);
      }
    }

    await Promise.all(executing);
    return results;
  }

  /**
   * Check if this router can handle the given context
   */
  canHandle(contextSize: number): boolean {
    // Qwen 3.6 has large context window (128k tokens)
    // Conservative limit: 100k tokens for safety margin
    const MAX_CONTEXT_SIZE = 100000;
    return contextSize <= MAX_CONTEXT_SIZE;
  }

  /**
   * Get current router metrics
   */
  getMetrics(): RouterMetrics {
    return { ...this.metrics };
  }

  /**
   * Acquire an execution slot with priority handling
   */
  private async acquireSlot(priority: RoutePriority): Promise<ExecutionSlot> {
    const timeoutMs =
      priority === 'critical'
        ? this.config.criticalTimeoutMs
        : this.config.defaultTimeoutMs;

    // Wait for available slot
    while (this.activeSlots.size >= this.config.maxConcurrency) {
      await this.sleep(50);
    }

    const slot: ExecutionSlot = {
      id: `slot_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      acquiredAt: Date.now(),
      expiresAt: Date.now() + timeoutMs,
    };

    this.activeSlots.set(slot.id, slot);
    this.metrics.currentLoad = this.activeSlots.size;

    return slot;
  }

  /**
   * Release an execution slot
   */
  private releaseSlot(slot: ExecutionSlot): void {
    this.activeSlots.delete(slot.id);
    this.metrics.currentLoad = this.activeSlots.size;
  }

  /**
   * Select execution strategy based on request characteristics
   */
  private selectStrategy(request: QwenRouteRequest): 'single' | 'batch' {
    if (request.operations.length > 1) {
      return 'batch';
    }
    return 'single';
  }

  /**
   * Execute a single operation
   */
  private async executeSingle(
    request: QwenRouteRequest,
    slot: ExecutionSlot
  ): Promise<QwenRouteResult> {
    try {
      // TODO: Integrate with actual Qwen 3.6 API client
      // For now, return scaffolded success result
      const completedOps: CompletedOperation[] = request.operations.map(
        (op) => ({
          ...op,
          success: true,
          latencyMs: 0,
        })
      );

      const result: QwenRouteResult = {
        taskId: request.taskId,
        success: true,
        operations: completedOps,
        metrics: {
          latencyMs: 0,
          tokensUsed: 0,
          cacheHitRatio: 0,
          retryCount: 0,
        },
      };

      return result;
    } finally {
      this.releaseSlot(slot);
    }
  }

  /**
   * Execute operations in batch
   */
  private async executeBatch(
    request: QwenRouteRequest,
    slot: ExecutionSlot
  ): Promise<QwenRouteResult> {
    // Batch execution: process operations in parallel chunks
    const chunkSize = this.config.maxConcurrency;
    const completedOps: CompletedOperation[] = [];
    let totalLatency = 0;

    for (let i = 0; i < request.operations.length; i += chunkSize) {
      const chunk = request.operations.slice(i, i + chunkSize);
      const chunkStart = Date.now();

      // Process chunk in parallel
      const chunkResults = await Promise.all(
        chunk.map(async (op) => {
          // TODO: Integrate with actual Qwen 3.6 API client
          const opStart = Date.now();
          return {
            ...op,
            success: true,
            latencyMs: Date.now() - opStart,
          };
        })
      );

      totalLatency += Date.now() - chunkStart;
      completedOps.push(...chunkResults);
    }

    const success = completedOps.every((op) => op.success);

    this.releaseSlot(slot);

    return {
      taskId: request.taskId,
      success,
      operations: completedOps,
      metrics: {
        latencyMs: totalLatency,
        tokensUsed: 0,
        cacheHitRatio: 0,
        retryCount: 0,
      },
      escalation: success ? undefined : 'max_retries_exceeded',
    };
  }

  /**
   * Create error result from exception
   */
  private createErrorResult(
    taskId: string,
    error: unknown
  ): QwenRouteResult {
    const message = error instanceof Error ? error.message : String(error);
    const escalation = this.classifyError(message);

    return {
      taskId,
      success: false,
      operations: [],
      metrics: {
        latencyMs: 0,
        tokensUsed: 0,
        cacheHitRatio: 0,
        retryCount: 0,
      },
      escalation,
    };
  }

  /**
   * Classify error for escalation decision
   */
  private classifyError(message: string): EscalationReason {
    if (message.includes('timeout')) return 'timeout';
    if (message.includes('context') || message.includes('token'))
      return 'context_overflow';
    if (message.includes('syntax') || message.includes('parse'))
      return 'syntax_error';
    if (message.includes('dependency') || message.includes('import'))
      return 'dependency_conflict';
    return 'max_retries_exceeded';
  }

  /**
   * Update router metrics
   */
  private updateMetrics(success: boolean, latencyMs: number): void {
    if (success) {
      this.metrics.successfulRequests++;
    } else {
      this.metrics.failedRequests++;
    }

    // Update running average latency
    this.requestHistory.push(latencyMs);
    if (this.requestHistory.length > 100) {
      this.requestHistory.shift();
    }
    this.metrics.averageLatencyMs =
      this.requestHistory.reduce((a, b) => a + b, 0) /
      this.requestHistory.length;
  }

  /**
   * Sleep utility
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** Singleton router instance */
export const qwenRouter = new QwenExecutorRouter();

/** Factory for custom router instances */
export function createQwenRouter(
  config?: Partial<RouterConfig>
): QwenExecutorRouter {
  return new QwenExecutorRouter(config);
}
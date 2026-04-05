/**
 * Thread 09: Qwen Executor Router
 * Primary executor model router for JackCode
 */

import type {
  CompletedOperation,
  EscalationReason,
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
  private slotSequence = 0;

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
      const slot = await this.acquireSlot(request.priority, request.timeoutMs);
      const strategy = this.selectStrategy(request);

      const result =
        strategy === 'batch' && this.config.enableBatching
          ? await this.executeBatch(request, slot)
          : await this.executeSingle(request, slot);

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

    const results = new Array<QwenRouteResult>(requests.length);
    const executing = new Set<Promise<void>>();

    for (const [index, request] of requests.entries()) {
      let promise!: Promise<void>;
      promise = this.route(request)
        .then((result) => {
          results[index] = result;
        })
        .finally(() => {
          executing.delete(promise);
        });

      executing.add(promise);

      if (executing.size >= this.config.maxConcurrency) {
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
    const maxContextSize = 100000;
    return contextSize <= maxContextSize;
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
  private async acquireSlot(
    priority: RoutePriority,
    requestTimeoutMs?: number
  ): Promise<ExecutionSlot> {
    const routerTimeoutMs =
      priority === 'critical'
        ? this.config.criticalTimeoutMs
        : this.config.defaultTimeoutMs;
    const normalizedRequestTimeout =
      requestTimeoutMs && requestTimeoutMs > 0 ? requestTimeoutMs : routerTimeoutMs;
    const effectiveTimeoutMs = Math.min(normalizedRequestTimeout, routerTimeoutMs);
    const waitDeadline = Date.now() + effectiveTimeoutMs;

    while (this.activeSlots.size >= this.config.maxConcurrency) {
      if (Date.now() >= waitDeadline) {
        throw new Error('timeout acquiring execution slot');
      }
      await this.sleep(50);
    }

    const acquiredAt = Date.now();
    const slot: ExecutionSlot = {
      id: `slot_${acquiredAt}_${this.slotSequence++}`,
      acquiredAt,
      expiresAt: acquiredAt + effectiveTimeoutMs,
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
    return request.operations.length > 1 ? 'batch' : 'single';
  }

  /**
   * Execute a single operation
   */
  private async executeSingle(
    request: QwenRouteRequest,
    slot: ExecutionSlot
  ): Promise<QwenRouteResult> {
    try {
      const completedOps: CompletedOperation[] = request.operations.map((op) => ({
        ...op,
        success: true,
        latencyMs: 0,
      }));

      return {
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
    try {
      const chunkSize = this.config.maxConcurrency;
      const completedOps: CompletedOperation[] = [];
      let totalLatency = 0;

      for (let index = 0; index < request.operations.length; index += chunkSize) {
        const chunk = request.operations.slice(index, index + chunkSize);
        const chunkStart = Date.now();

        const chunkResults = await Promise.all(
          chunk.map(async (op) => {
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
    } finally {
      this.releaseSlot(slot);
    }
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
    const normalized = message.toLowerCase();

    if (normalized.includes('timeout')) return 'timeout';
    if (normalized.includes('context') || normalized.includes('token')) {
      return 'context_overflow';
    }
    if (normalized.includes('syntax') || normalized.includes('parse')) {
      return 'syntax_error';
    }
    if (normalized.includes('dependency') || normalized.includes('import')) {
      return 'dependency_conflict';
    }

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

    this.requestHistory.push(latencyMs);
    if (this.requestHistory.length > 100) {
      this.requestHistory.shift();
    }
    this.metrics.averageLatencyMs =
      this.requestHistory.reduce((sum, value) => sum + value, 0) /
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

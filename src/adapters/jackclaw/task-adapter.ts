/**
 * JackClaw Collaboration Adapter
 * Thread 15: Subagent task delegation and result aggregation
 *
 * Enables JackCode to spawn OpenClaw subagents for parallel task execution.
 */

import { randomUUID } from 'crypto';
import type {
  SubagentTask,
  SubagentResult,
  SubagentHandle,
  SubagentStatus,
  SubagentOutputs,
  GeneratedFile,
  AggregatedResult,
  TaskHandoffEvent,
  SubagentPoolConfig,
} from './types/collaboration.js';
import type { Patch } from '../../types/patch.js';

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  'success',
  'failure',
  'timeout',
  'cancelled',
]);

interface Waiter {
  resolve: (result: SubagentResult) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Default pool configuration
 */
const DEFAULT_CONFIG: SubagentPoolConfig = {
  maxConcurrent: 5,
  defaultTimeout: 300000,
  maxRetries: 2,
};

/**
 * JackClaw Collaboration Adapter
 * Manages spawning and lifecycle of OpenClaw subagents
 */
export class JackClawCollaborationAdapter {
  private config: SubagentPoolConfig;
  private activeAgents = new Map<string, SubagentHandle>();
  private completedResults = new Map<string, SubagentResult>();
  private waiters = new Map<string, Waiter>();
  private eventListeners: Array<(event: TaskHandoffEvent) => void> = [];
  private runningCount = 0;

  constructor(config: Partial<SubagentPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Spawn a new OpenClaw subagent for task execution
   */
  async spawn(task: SubagentTask): Promise<SubagentHandle> {
    if (this.runningCount >= this.config.maxConcurrent) {
      throw new Error(`Max concurrent subagents (${this.config.maxConcurrent}) reached`);
    }

    const subagentId = randomUUID();
    const handle: SubagentHandle = {
      id: subagentId,
      taskId: task.taskId,
      status: 'pending',
      createdAt: Date.now(),
    };

    this.activeAgents.set(subagentId, handle);
    this.runningCount += 1;

    this.emitEvent({
      type: 'spawn',
      timestamp: Date.now(),
      handle: { ...handle },
    });

    void this.executeSubagent(subagentId, task).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      this.finalizeHandle(handle, this.buildResult(handle, task.taskId, 'failure', {
        errors: [message],
      }));
    });

    return handle;
  }

  /**
   * Wait for a subagent to complete and return its result
   */
  async waitFor(handle: SubagentHandle): Promise<SubagentResult> {
    const existingResult = this.completedResults.get(handle.id);
    if (existingResult) {
      return existingResult;
    }

    const current = this.activeAgents.get(handle.id);
    if (!current) {
      throw new Error(`Subagent ${handle.id} not found`);
    }

    if (TERMINAL_STATUSES.has(current.status)) {
      const result = this.buildResult(current, current.taskId, current.status as 'success' | 'failure' | 'timeout' | 'cancelled');
      this.completedResults.set(current.id, result);
      return result;
    }

    if (this.waiters.has(handle.id)) {
      throw new Error(`Subagent ${handle.id} is already being awaited`);
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const active = this.activeAgents.get(handle.id);
        if (!active || TERMINAL_STATUSES.has(active.status)) {
          return;
        }

        const result = this.buildResult(active, active.taskId, 'timeout', {
          errors: [`Subagent ${handle.id} timed out`],
        });
        this.finalizeHandle(active, result);
      }, this.config.defaultTimeout);

      this.waiters.set(handle.id, { resolve, reject, timeout });
    });
  }

  /**
   * Cancel a running or pending subagent
   */
  async cancel(handle: SubagentHandle): Promise<void> {
    const current = this.activeAgents.get(handle.id);
    if (!current) {
      throw new Error(`Subagent ${handle.id} not found`);
    }

    if (TERMINAL_STATUSES.has(current.status)) {
      return;
    }

    const result = this.buildResult(current, current.taskId, 'cancelled', {
      errors: ['Subagent cancelled'],
    });
    this.finalizeHandle(current, result);
  }

  /**
   * Get current status of a subagent
   */
  async status(handle: SubagentHandle): Promise<SubagentStatus> {
    return this.activeAgents.get(handle.id)?.status
      ?? this.completedResults.get(handle.id)?.status
      ?? 'cancelled';
  }

  /**
   * Aggregate results from multiple subagents
   */
  aggregate(results: SubagentResult[]): AggregatedResult {
    const allSuccess = results.every((r) => r.status === 'success');
    const failures = results.filter((r) => r.status !== 'success').map((r) => r.taskId);

    const combined: AggregatedResult['combined'] = {
      files: [],
      analysis: [],
      patches: [],
      verifications: [],
      metadata: [],
    };

    for (const result of results) {
      if (result.outputs.files) {
        combined.files.push(...result.outputs.files);
      }
      if (result.outputs.analysis) {
        combined.analysis.push(result.outputs.analysis);
      }
      if (result.outputs.patch) {
        combined.patches.push(result.outputs.patch as Patch);
      }
      if (typeof result.outputs.verification === 'boolean') {
        combined.verifications.push(result.outputs.verification);
      }
      if (result.outputs.metadata) {
        combined.metadata.push(result.outputs.metadata);
      }
    }

    const totals = results.reduce(
      (acc, result) => ({
        duration: acc.duration + Math.max(0, result.metrics.endTime - result.metrics.startTime),
        tokensUsed: acc.tokensUsed + result.metrics.tokensUsed,
        estimatedCost: acc.estimatedCost + (result.metrics.estimatedCost ?? 0),
      }),
      { duration: 0, tokensUsed: 0, estimatedCost: 0 },
    );

    return {
      results,
      allSuccess,
      combined,
      totals,
      failures,
    };
  }

  /**
   * Subscribe to task handoff events
   */
  onHandoff(listener: (event: TaskHandoffEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Remove a handoff listener
   */
  offHandoff(listener: (event: TaskHandoffEvent) => void): void {
    this.eventListeners = this.eventListeners.filter((entry) => entry !== listener);
  }

  /**
   * Dispose adapter resources
   */
  dispose(): void {
    for (const waiter of this.waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(new Error('Collaboration adapter disposed'));
    }
    this.waiters.clear();
    this.eventListeners = [];
    this.activeAgents.clear();
    this.completedResults.clear();
    this.runningCount = 0;
  }

  /**
   * Get count of active subagents
   */
  getActiveCount(): number {
    return this.runningCount;
  }

  /**
   * Get all active subagent handles
   */
  getActiveAgents(): SubagentHandle[] {
    return Array.from(this.activeAgents.values()).filter(
      (handle) => !TERMINAL_STATUSES.has(handle.status),
    );
  }

  /**
   * Execute subagent task (internal)
   */
  private async executeSubagent(subagentId: string, task: SubagentTask): Promise<void> {
    const handle = this.activeAgents.get(subagentId);
    if (!handle) {
      return;
    }

    handle.status = 'running';
    const result = await this.simulateExecution(task, handle);
    this.finalizeHandle(handle, result);
  }

  /**
   * Simulate subagent execution (placeholder)
   */
  private async simulateExecution(task: SubagentTask, handle: SubagentHandle): Promise<SubagentResult> {
    const durationMs = Math.min(Math.max(task.timeout || 250, 250), 1000);
    await new Promise((resolve) => setTimeout(resolve, durationMs));

    if (handle.status === 'cancelled') {
      return this.buildResult(handle, task.taskId, 'cancelled', {
        errors: ['Subagent cancelled'],
      });
    }

    return this.buildResult(handle, task.taskId, 'success', {
      outputs: {
        analysis: `Completed task: ${task.goal}`,
        metadata: {
          sessionId: task.sessionId,
          expectedOutputType: task.expectedOutput.type,
        },
      },
      metrics: {
        tokensUsed: Math.max(1, Math.ceil(task.goal.length / 4)),
      },
    });
  }

  /**
   * Build result object from handle
   */
  private buildResult(
    handle: SubagentHandle,
    taskId: string,
    status: Extract<SubagentStatus, 'success' | 'failure' | 'timeout' | 'cancelled'>,
    overrides: {
      outputs?: SubagentOutputs;
      metrics?: Partial<SubagentResult['metrics']>;
      errors?: string[];
    } = {},
  ): SubagentResult {
    const now = Date.now();
    const startTime = handle.createdAt;

    return {
      taskId,
      subagentId: handle.id,
      status,
      outputs: overrides.outputs ?? (status === 'success' ? { analysis: `Completed task: ${taskId}` } : {}),
      metrics: {
        startTime,
        endTime: now,
        tokensUsed: overrides.metrics?.tokensUsed ?? 0,
        estimatedCost: overrides.metrics?.estimatedCost,
      },
      errors: overrides.errors,
    };
  }

  /**
   * Finalize subagent state and resolve any waiters
   */
  private finalizeHandle(handle: SubagentHandle, result: SubagentResult): void {
    if (TERMINAL_STATUSES.has(handle.status) && this.completedResults.has(handle.id)) {
      return;
    }

    handle.status = result.status;
    this.completedResults.set(handle.id, result);
    this.runningCount = Math.max(0, this.runningCount - 1);

    const waiter = this.waiters.get(handle.id);
    if (waiter) {
      clearTimeout(waiter.timeout);
      this.waiters.delete(handle.id);
      waiter.resolve(result);
    }

    const eventType: TaskHandoffEvent['type'] = result.status === 'success'
      ? 'complete'
      : result.status === 'cancelled'
        ? 'cancel'
        : 'fail';

    this.emitEvent({
      type: eventType,
      timestamp: Date.now(),
      handle: { ...handle },
      result,
    });
  }

  /**
   * Emit handoff event to all listeners
   */
  private emitEvent(event: TaskHandoffEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[CollaborationAdapter] Event listener failed:', error);
      }
    }
  }
}

/**
 * Factory function for creating adapter instances
 */
export function createCollaborationAdapter(
  config?: Partial<SubagentPoolConfig>,
): JackClawCollaborationAdapter {
  return new JackClawCollaborationAdapter(config);
}

/**
 * Singleton instance for global use
 */
export const collaborationAdapter = new JackClawCollaborationAdapter();

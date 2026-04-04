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
  SubagentMetrics,
  GeneratedFile,
  AggregatedResult,
  TaskHandoffEvent,
  SubagentPoolConfig,
} from './types/collaboration.js';

/**
 * Default pool configuration
 */
const DEFAULT_CONFIG: SubagentPoolConfig = {
  maxConcurrent: 5,
  defaultTimeout: 300000, // 5 minutes
  maxRetries: 2,
};

/**
 * JackClaw Collaboration Adapter
 * Manages spawning and lifecycle of OpenClaw subagents
 */
export class JackClawCollaborationAdapter {
  private config: SubagentPoolConfig;
  private activeAgents: Map<string, SubagentHandle> = new Map();
  private eventListeners: Array<(event: TaskHandoffEvent) => void> = [];
  private runningCount: number = 0;

  constructor(config: Partial<SubagentPoolConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Spawn a new OpenClaw subagent for task execution
   * 
   * @param task - Task definition with goal and context
   * @returns Handle to track the subagent
   */
  async spawn(task: SubagentTask): Promise<SubagentHandle> {
    // Check concurrency limit
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
    this.runningCount++;

    // Emit spawn event
    this.emitEvent({
      type: 'spawn',
      timestamp: Date.now(),
      handle,
    });

    // Start subagent execution (async)
    this.executeSubagent(subagentId, task).catch((error) => {
      console.error(`[CollaborationAdapter] Subagent ${subagentId} failed:`, error);
      handle.status = 'failure';
      this.runningCount--;
      this.emitEvent({
        type: 'fail',
        timestamp: Date.now(),
        handle,
      });
    });

    return handle;
  }

  /**
   * Wait for a subagent to complete and return its result
   * 
   * @param handle - Subagent handle from spawn()
   * @returns Subagent execution result
   */
  async waitFor(handle: SubagentHandle): Promise<SubagentResult> {
    return new Promise((resolve, reject) => {
      const checkInterval = setInterval(() => {
        const current = this.activeAgents.get(handle.id);
        if (!current) {
          clearInterval(checkInterval);
          reject(new Error(`Subagent ${handle.id} not found`));
          return;
        }

        if (current.status === 'success' || 
            current.status === 'failure' || 
            current.status === 'timeout' ||
            current.status === 'cancelled') {
          clearInterval(checkInterval);
          
          // Retrieve result (simplified - in real impl would use result store)
          const result = this.buildResult(current, handle.taskId);
          resolve(result);
        }
      }, 100);

      // Timeout protection
      setTimeout(() => {
        clearInterval(checkInterval);
        handle.status = 'timeout';
        reject(new Error(`Subagent ${handle.id} timed out`));
      }, this.config.defaultTimeout);
    });
  }

  /**
   * Cancel a running subagent
   * 
   * @param handle - Subagent handle to cancel
   */
  async cancel(handle: SubagentHandle): Promise<void> {
    const current = this.activeAgents.get(handle.id);
    if (!current) {
      throw new Error(`Subagent ${handle.id} not found`);
    }

    if (current.status === 'running') {
      // In real implementation: call OpenClaw session kill API
      current.status = 'cancelled';
      this.runningCount--;
      
      this.emitEvent({
        type: 'cancel',
        timestamp: Date.now(),
        handle: current,
      });
    }
  }

  /**
   * Get current status of a subagent
   * 
   * @param handle - Subagent handle
   * @returns Current status
   */
  async status(handle: SubagentHandle): Promise<SubagentStatus> {
    const current = this.activeAgents.get(handle.id);
    return current?.status || 'cancelled';
  }

  /**
   * Aggregate results from multiple subagents
   * 
   * @param results - Array of subagent results
   * @returns Aggregated result with combined outputs
   */
  aggregate(results: SubagentResult[]): AggregatedResult {
    const allSuccess = results.every(r => r.status === 'success');
    const failures = results.filter(r => r.status !== 'success').map(r => r.taskId);

    // Combine outputs
    const combined = {
      files: [] as GeneratedFile[],
      analysis: [] as string[],
      patches: [] as unknown[],
    };

    for (const result of results) {
      if (result.outputs.files) {
        combined.files.push(...result.outputs.files);
      }
      if (result.outputs.analysis) {
        combined.analysis.push(result.outputs.analysis);
      }
      if (result.outputs.patch) {
        combined.patches.push(result.outputs.patch);
      }
    }

    // Calculate totals
    const totals = results.reduce((acc, r) => ({
      duration: acc.duration + (r.metrics.endTime - r.metrics.startTime),
      tokensUsed: acc.tokensUsed + r.metrics.tokensUsed,
      estimatedCost: acc.estimatedCost + (r.metrics.estimatedCost || 0),
    }), { duration: 0, tokensUsed: 0, estimatedCost: 0 });

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
   * 
   * @param listener - Event callback
   */
  onHandoff(listener: (event: TaskHandoffEvent) => void): void {
    this.eventListeners.push(listener);
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
    return Array.from(this.activeAgents.values());
  }

  /**
   * Execute subagent task (internal)
   * 
   * In real implementation: calls OpenClaw acpx sessions API
   * For now: simulates execution with placeholder logic
   */
  private async executeSubagent(subagentId: string, task: SubagentTask): Promise<void> {
    const handle = this.activeAgents.get(subagentId);
    if (!handle) return;

    // Update status to running
    handle.status = 'running';

    // Simulate subagent execution
    // In real implementation:
    // 1. Call OpenClaw CLI: `openclaw sessions spawn --task "${task.goal}"`
    // 2. Stream context files to subagent session
    // 3. Poll for completion via session status API
    // 4. Retrieve results from session output

    await this.simulateExecution(task, handle);
  }

  /**
   * Simulate subagent execution (placeholder)
   */
  private async simulateExecution(task: SubagentTask, handle: SubagentHandle): Promise<void> {
    // Simulate work
    await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
    
    // Randomly succeed or fail for testing
    const shouldFail = Math.random() < 0.1; // 10% failure rate
    
    if (shouldFail) {
      handle.status = 'failure';
      this.runningCount--;
      this.emitEvent({
        type: 'fail',
        timestamp: Date.now(),
        handle,
      });
    } else {
      handle.status = 'success';
      this.runningCount--;
      this.emitEvent({
        type: 'complete',
        timestamp: Date.now(),
        handle,
      });
    }
  }

  /**
   * Build result object from handle (placeholder)
   * 
   * In real implementation:
   * - Retrieve from session result store
   * - Parse structured output from subagent
   */
  private buildResult(handle: SubagentHandle, taskId: string): SubagentResult {
    const now = Date.now();
    const startTime = handle.createdAt;
    
    // Build placeholder result based on status
    const outputs: SubagentOutputs = handle.status === 'success' 
      ? { analysis: `Completed task: ${taskId}` }
      : {};

    const errors = handle.status === 'failure' 
      ? ['Subagent execution failed'] 
      : undefined;

    return {
      taskId,
      subagentId: handle.id,
      status: handle.status,
      outputs,
      metrics: {
        startTime,
        endTime: now,
        tokensUsed: Math.floor(Math.random() * 5000), // Placeholder
      },
      errors,
    };
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
  config?: Partial<SubagentPoolConfig>
): JackClawCollaborationAdapter {
  return new JackClawCollaborationAdapter(config);
}

/**
 * Singleton instance for global use
 */
export const collaborationAdapter = new JackClawCollaborationAdapter();
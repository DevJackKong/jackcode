/**
 * Subagent Pool Manager
 * Thread 15: Manages lifecycle of multiple OpenClaw subagents
 */

import { randomUUID } from 'crypto';
import { JackClawCollaborationAdapter } from './task-adapter.js';
import type {
  SubagentTask,
  SubagentResult,
  SubagentHandle,
  SubagentPoolConfig,
  TaskHandoffEvent,
} from './types/collaboration.js';

/**
 * Pool entry with task metadata
 */
interface PoolEntry {
  handle: SubagentHandle;
  task: SubagentTask;
  promise: Promise<SubagentResult>;
  resolve: (result: SubagentResult) => void;
  reject: (error: Error) => void;
}

/**
 * Subagent Pool
 * Manages concurrent execution of multiple subagents with
 * queuing, load balancing, and result aggregation.
 */
export class SubagentPool {
  private adapter: JackClawCollaborationAdapter;
  private config: SubagentPoolConfig;
  private entries: Map<string, PoolEntry> = new Map();
  private queue: SubagentTask[] = [];
  private processing: boolean = false;

  constructor(config: Partial<SubagentPoolConfig> = {}) {
    this.config = {
      maxConcurrent: 5,
      defaultTimeout: 300000,
      maxRetries: 2,
      ...config,
    };
    this.adapter = new JackClawCollaborationAdapter(this.config);
  }

  /**
   * Submit a task to the pool
   * Returns immediately; task may be queued
   * 
   * @param task - Task to execute
   * @returns Promise that resolves with result
   */
  async submit(task: SubagentTask): Promise<SubagentResult> {
    return new Promise((resolve, reject) => {
      // Create entry with deferred resolution
      const entry: Partial<PoolEntry> = {
        task,
        resolve,
        reject,
        promise: new Promise(() => {}), // Placeholder
      };

      // Check if we can run immediately
      if (this.adapter.getActiveCount() < this.config.maxConcurrent) {
        this.execute(entry as PoolEntry);
      } else {
        // Queue for later
        this.queue.push(task);
        // Store entry for later execution
        this.entries.set(task.taskId, entry as PoolEntry);
      }
    });
  }

  /**
   * Submit multiple tasks and wait for all
   * 
   * @param tasks - Array of tasks
   * @returns Array of results (preserves order)
   */
  async submitAll(tasks: SubagentTask[]): Promise<SubagentResult[]> {
    const promises = tasks.map(task => this.submit(task));
    return Promise.all(promises);
  }

  /**
   * Submit multiple tasks and return results as they complete
   * 
   * @param tasks - Array of tasks
   * @returns Async iterator of results
   */
  async *submitIterator(tasks: SubagentTask[]): AsyncGenerator<SubagentResult> {
    const promises = tasks.map(task => this.submit(task));
    
    // Track completions
    const pending = new Set(promises.map((p, i) => i));
    
    while (pending.size > 0) {
      // Race all pending promises
      const result = await Promise.race(
        Array.from(pending).map(i => 
          promises[i].then(value => ({ index: i, value }))
        )
      );
      
      pending.delete(result.index);
      yield result.value;
    }
  }

  /**
   * Cancel all running and queued tasks
   */
  async cancelAll(): Promise<void> {
    // Cancel queued tasks
    for (const task of this.queue) {
      const entry = this.entries.get(task.taskId);
      if (entry) {
        entry.reject(new Error('Task cancelled (pool cleared)'));
      }
    }
    this.queue = [];

    // Cancel running tasks
    const active = this.adapter.getActiveAgents();
    for (const handle of active) {
      await this.adapter.cancel(handle);
    }
  }

  /**
   * Get current pool statistics
   */
  getStats(): {
    active: number;
    queued: number;
    total: number;
    maxConcurrent: number;
  } {
    return {
      active: this.adapter.getActiveCount(),
      queued: this.queue.length,
      total: this.entries.size + this.queue.length,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  /**
   * Subscribe to handoff events
   * 
   * @param listener - Event handler
   */
  onHandoff(listener: (event: TaskHandoffEvent) => void): void {
    this.adapter.onHandoff(listener);
  }

  /**
   * Execute a pool entry
   */
  private async execute(entry: PoolEntry): Promise<void> {
    try {
      const handle = await this.adapter.spawn(entry.task);
      entry.handle = handle;
      this.entries.set(entry.task.taskId, entry);

      // Wait for completion
      const result = await this.adapter.waitFor(handle);
      
      // Handle retry logic for failures
      if (result.status === 'failure' && this.config.maxRetries > 0) {
        const retryResult = await this.retryTask(entry.task);
        entry.resolve(retryResult);
      } else {
        entry.resolve(result);
      }
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
    } finally {
      // Process next from queue
      this.processQueue();
    }
  }

  /**
   * Retry a failed task
   */
  private async retryTask(task: SubagentTask, attempt: number = 1): Promise<SubagentResult> {
    if (attempt > this.config.maxRetries) {
      return {
        taskId: task.taskId,
        subagentId: 'retry-failed',
        status: 'failure',
        outputs: {},
        metrics: {
          startTime: Date.now(),
          endTime: Date.now(),
          tokensUsed: 0,
        },
        errors: [`Failed after ${this.config.maxRetries} retries`],
      };
    }

    try {
      const handle = await this.adapter.spawn(task);
      const result = await this.adapter.waitFor(handle);
      
      if (result.status === 'failure') {
        return await this.retryTask(task, attempt + 1);
      }
      
      return result;
    } catch (error) {
      return await this.retryTask(task, attempt + 1);
    }
  }

  /**
   * Process queued tasks
   */
  private processQueue(): void {
    while (
      this.queue.length > 0 &&
      this.adapter.getActiveCount() < this.config.maxConcurrent
    ) {
      const task = this.queue.shift()!;
      const entry = this.entries.get(task.taskId);
      
      if (entry) {
        this.execute(entry);
      }
    }
  }
}

/**
 * Create a new subagent pool
 */
export function createSubagentPool(
  config?: Partial<SubagentPoolConfig>
): SubagentPool {
  return new SubagentPool(config);
}

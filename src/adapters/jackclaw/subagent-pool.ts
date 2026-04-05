/**
 * Subagent Pool Manager
 * Thread 15: Manages lifecycle of multiple OpenClaw subagents
 */

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
  handle?: SubagentHandle;
  task: SubagentTask;
  resolve: (result: SubagentResult) => void;
  reject: (error: Error) => void;
  retries: number;
}

/**
 * Subagent Pool
 * Manages concurrent execution of multiple subagents with
 * queuing, load balancing, and result aggregation.
 */
export class SubagentPool {
  private adapter: JackClawCollaborationAdapter;
  private config: SubagentPoolConfig;
  private entries = new Map<string, PoolEntry>();
  private queue: string[] = [];

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
   */
  async submit(task: SubagentTask): Promise<SubagentResult> {
    if (this.entries.has(task.taskId)) {
      throw new Error(`Task ${task.taskId} is already submitted`);
    }

    return new Promise((resolve, reject) => {
      const entry: PoolEntry = {
        task,
        resolve,
        reject,
        retries: 0,
      };

      this.entries.set(task.taskId, entry);

      if (this.adapter.getActiveCount() < this.config.maxConcurrent) {
        void this.execute(entry);
      } else {
        this.queue.push(task.taskId);
      }
    });
  }

  /**
   * Submit multiple tasks and wait for all
   */
  async submitAll(tasks: SubagentTask[]): Promise<SubagentResult[]> {
    return Promise.all(tasks.map((task) => this.submit(task)));
  }

  /**
   * Submit multiple tasks and return results as they complete
   */
  async *submitIterator(tasks: SubagentTask[]): AsyncGenerator<SubagentResult> {
    const pending = new Map<number, Promise<{ index: number; value: SubagentResult }>>();

    tasks.forEach((task, index) => {
      pending.set(index, this.submit(task).then((value) => ({ index, value })));
    });

    while (pending.size > 0) {
      const result = await Promise.race(pending.values());
      pending.delete(result.index);
      yield result.value;
    }
  }

  /**
   * Cancel all running and queued tasks
   */
  async cancelAll(): Promise<void> {
    for (const taskId of this.queue) {
      const entry = this.entries.get(taskId);
      if (entry) {
        entry.reject(new Error('Task cancelled (pool cleared)'));
        this.entries.delete(taskId);
      }
    }
    this.queue = [];

    const active = this.adapter.getActiveAgents();
    await Promise.all(active.map((handle) => this.adapter.cancel(handle)));
  }

  /**
   * Dispose of pool resources
   */
  dispose(): void {
    this.queue = [];
    this.entries.clear();
    this.adapter.dispose();
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
      total: this.entries.size,
      maxConcurrent: this.config.maxConcurrent,
    };
  }

  /**
   * Subscribe to handoff events
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

      const result = await this.adapter.waitFor(handle);
      if (result.status === 'failure' && entry.retries < this.config.maxRetries) {
        entry.retries += 1;
        this.queue.unshift(entry.task.taskId);
      } else {
        entry.resolve(result);
        this.entries.delete(entry.task.taskId);
      }
    } catch (error) {
      entry.reject(error instanceof Error ? error : new Error(String(error)));
      this.entries.delete(entry.task.taskId);
    } finally {
      this.processQueue();
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
      const taskId = this.queue.shift();
      if (!taskId) {
        continue;
      }

      const entry = this.entries.get(taskId);
      if (entry) {
        void this.execute(entry);
      }
    }
  }
}

/**
 * Create a new subagent pool
 */
export function createSubagentPool(
  config?: Partial<SubagentPoolConfig>,
): SubagentPool {
  return new SubagentPool(config);
}

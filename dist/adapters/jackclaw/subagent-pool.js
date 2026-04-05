/**
 * Subagent Pool Manager
 * Thread 15: Manages lifecycle of multiple OpenClaw subagents
 */
import { JackClawCollaborationAdapter } from './collaboration.js';
export class SubagentPool {
    adapter;
    config;
    entries = new Map();
    queue = [];
    constructor(config = {}) {
        this.config = {
            maxConcurrent: 5,
            defaultTimeout: 300000,
            maxRetries: 2,
            ...config,
        };
        this.adapter = new JackClawCollaborationAdapter(this.config);
    }
    async submit(task) {
        if (this.entries.has(task.taskId)) {
            throw new Error(`Task ${task.taskId} is already submitted`);
        }
        return new Promise((resolve, reject) => {
            const entry = {
                task,
                resolve,
                reject,
                retries: 0,
            };
            this.entries.set(task.taskId, entry);
            if (this.adapter.getActiveCount() < this.config.maxConcurrent) {
                void this.execute(entry);
            }
            else {
                this.queue.push(task.taskId);
            }
        });
    }
    async submitAll(tasks) {
        return Promise.all(tasks.map((task) => this.submit(task)));
    }
    async *submitIterator(tasks) {
        const pending = new Map();
        tasks.forEach((task, index) => {
            pending.set(index, this.submit(task).then((value) => ({ index, value })));
        });
        while (pending.size > 0) {
            const result = await Promise.race(pending.values());
            pending.delete(result.index);
            yield result.value;
        }
    }
    async cancelAll() {
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
    dispose() {
        this.queue = [];
        this.entries.clear();
        this.adapter.dispose();
    }
    getStats() {
        return {
            active: this.adapter.getActiveCount(),
            queued: this.queue.length,
            total: this.entries.size,
            maxConcurrent: this.config.maxConcurrent,
        };
    }
    onHandoff(listener) {
        this.adapter.onHandoff(listener);
    }
    async execute(entry) {
        try {
            const handle = await this.adapter.spawn(entry.task);
            entry.handle = handle;
            const result = await this.adapter.waitFor(handle);
            if ((result.status === 'failure' || result.status === 'timeout') && entry.retries < this.config.maxRetries) {
                entry.retries += 1;
                this.queue.unshift(entry.task.taskId);
            }
            else {
                entry.resolve(result);
                this.entries.delete(entry.task.taskId);
            }
        }
        catch (error) {
            entry.reject(error instanceof Error ? error : new Error(String(error)));
            this.entries.delete(entry.task.taskId);
        }
        finally {
            this.processQueue();
        }
    }
    processQueue() {
        while (this.queue.length > 0 &&
            this.adapter.getActiveCount() < this.config.maxConcurrent) {
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
export function createSubagentPool(config) {
    return new SubagentPool(config);
}

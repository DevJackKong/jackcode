/**
 * JackClaw Collaboration Adapter
 * Thread 15: Subagent task delegation and result aggregation
 *
 * Enables JackCode to spawn OpenClaw subagents for parallel task execution.
 */
import { randomUUID } from 'crypto';
const TERMINAL_STATUSES = new Set([
    'success',
    'failure',
    'timeout',
    'cancelled',
]);
/**
 * Default pool configuration
 */
const DEFAULT_CONFIG = {
    maxConcurrent: 5,
    defaultTimeout: 300000,
    maxRetries: 2,
};
/**
 * JackClaw Collaboration Adapter
 * Manages spawning and lifecycle of OpenClaw subagents
 */
export class JackClawCollaborationAdapter {
    config;
    activeAgents = new Map();
    completedResults = new Map();
    waiters = new Map();
    eventListeners = [];
    runningCount = 0;
    constructor(config = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }
    /**
     * Spawn a new OpenClaw subagent for task execution
     */
    async spawn(task) {
        if (this.runningCount >= this.config.maxConcurrent) {
            throw new Error(`Max concurrent subagents (${this.config.maxConcurrent}) reached`);
        }
        const subagentId = randomUUID();
        const handle = {
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
    async waitFor(handle) {
        const existingResult = this.completedResults.get(handle.id);
        if (existingResult) {
            return existingResult;
        }
        const current = this.activeAgents.get(handle.id);
        if (!current) {
            throw new Error(`Subagent ${handle.id} not found`);
        }
        if (TERMINAL_STATUSES.has(current.status)) {
            const result = this.buildResult(current, current.taskId, current.status);
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
    async cancel(handle) {
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
    async status(handle) {
        return this.activeAgents.get(handle.id)?.status
            ?? this.completedResults.get(handle.id)?.status
            ?? 'cancelled';
    }
    /**
     * Aggregate results from multiple subagents
     */
    aggregate(results) {
        const allSuccess = results.every((r) => r.status === 'success');
        const failures = results.filter((r) => r.status !== 'success').map((r) => r.taskId);
        const combined = {
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
                combined.patches.push(result.outputs.patch);
            }
            if (typeof result.outputs.verification === 'boolean') {
                combined.verifications.push(result.outputs.verification);
            }
            if (result.outputs.metadata) {
                combined.metadata.push(result.outputs.metadata);
            }
        }
        const totals = results.reduce((acc, result) => ({
            duration: acc.duration + Math.max(0, result.metrics.endTime - result.metrics.startTime),
            tokensUsed: acc.tokensUsed + result.metrics.tokensUsed,
            estimatedCost: acc.estimatedCost + (result.metrics.estimatedCost ?? 0),
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
     */
    onHandoff(listener) {
        this.eventListeners.push(listener);
    }
    /**
     * Remove a handoff listener
     */
    offHandoff(listener) {
        this.eventListeners = this.eventListeners.filter((entry) => entry !== listener);
    }
    /**
     * Dispose adapter resources
     */
    dispose() {
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
    getActiveCount() {
        return this.runningCount;
    }
    /**
     * Get all active subagent handles
     */
    getActiveAgents() {
        return Array.from(this.activeAgents.values()).filter((handle) => !TERMINAL_STATUSES.has(handle.status));
    }
    /**
     * Execute subagent task (internal)
     */
    async executeSubagent(subagentId, task) {
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
    async simulateExecution(task, handle) {
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
    buildResult(handle, taskId, status, overrides = {}) {
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
    finalizeHandle(handle, result) {
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
        const eventType = result.status === 'success'
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
    emitEvent(event) {
        for (const listener of this.eventListeners) {
            try {
                listener(event);
            }
            catch (error) {
                console.error('[CollaborationAdapter] Event listener failed:', error);
            }
        }
    }
}
/**
 * Factory function for creating adapter instances
 */
export function createCollaborationAdapter(config) {
    return new JackClawCollaborationAdapter(config);
}
/**
 * Singleton instance for global use
 */
export const collaborationAdapter = new JackClawCollaborationAdapter();

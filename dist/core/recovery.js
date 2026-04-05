/**
 * Thread 19: Recovery, Retry, Safety, Rollback, and Monitoring
 */
import { randomUUID } from 'crypto';
import { DEFAULT_RECOVERY_CONFIG } from '../types/repairer.js';
export class RecoveryError extends Error {
    category;
    severity;
    retryable;
    code;
    constructor(message, options) {
        super(message);
        this.name = 'RecoveryError';
        this.category = options.category;
        this.severity = options.severity ?? 'medium';
        this.retryable = options.retryable ?? options.category === 'transient';
        this.code = options.code;
    }
}
export class TransientRecoveryError extends RecoveryError {
    constructor(message, code) {
        super(message, { category: 'transient', severity: 'medium', retryable: true, code });
        this.name = 'TransientRecoveryError';
    }
}
export class PermanentRecoveryError extends RecoveryError {
    constructor(message, code) {
        super(message, { category: 'permanent', severity: 'high', retryable: false, code });
        this.name = 'PermanentRecoveryError';
    }
}
export class SafetyRecoveryError extends RecoveryError {
    constructor(message, code) {
        super(message, { category: 'safety', severity: 'critical', retryable: false, code });
        this.name = 'SafetyRecoveryError';
    }
}
export class TimeoutRecoveryError extends RecoveryError {
    constructor(message = 'Operation timed out', code = 'TIMEOUT') {
        super(message, { category: 'transient', severity: 'high', retryable: true, code });
        this.name = 'TimeoutRecoveryError';
    }
}
export class RecoveryMonitor {
    metrics = {
        totalOperations: 0,
        successfulOperations: 0,
        failedOperations: 0,
        retriedOperations: 0,
        recoveredOperations: 0,
        fallbackActivations: 0,
        rollbackAttempts: 0,
        rollbackSuccesses: 0,
        circuitOpenEvents: 0,
        alerts: [],
        failuresByCategory: {
            transient: 0,
            permanent: 0,
            safety: 0,
            unknown: 0,
        },
        averageAttempts: 0,
        successRate: 0,
    };
    recordOperation(success, attempts) {
        this.metrics.totalOperations++;
        if (success)
            this.metrics.successfulOperations++;
        else
            this.metrics.failedOperations++;
        if (attempts > 1)
            this.metrics.retriedOperations++;
        this.refreshDerivedMetrics(attempts);
    }
    recordRecovered() {
        this.metrics.recoveredOperations++;
    }
    recordFailure(category) {
        this.metrics.failuresByCategory[category]++;
    }
    recordFallback() {
        this.metrics.fallbackActivations++;
    }
    recordCircuitOpened() {
        this.metrics.circuitOpenEvents++;
    }
    recordRollback(success) {
        this.metrics.rollbackAttempts++;
        if (success)
            this.metrics.rollbackSuccesses++;
    }
    alert(level, code, message, taskId) {
        const alert = { level, code, message, timestamp: Date.now(), taskId };
        this.metrics.alerts.push(alert);
        return alert;
    }
    analyzeFailures() {
        return Object.entries(this.metrics.failuresByCategory)
            .map(([category, count]) => ({ category: category, count }))
            .sort((a, b) => b.count - a.count);
    }
    getMetrics() {
        return {
            ...this.metrics,
            alerts: [...this.metrics.alerts],
            failuresByCategory: { ...this.metrics.failuresByCategory },
        };
    }
    refreshDerivedMetrics(lastAttempts) {
        const prevCompleted = Math.max(0, this.metrics.totalOperations - 1);
        this.metrics.averageAttempts = prevCompleted === 0
            ? lastAttempts
            : ((this.metrics.averageAttempts * prevCompleted) + lastAttempts) / this.metrics.totalOperations;
        this.metrics.successRate = this.metrics.totalOperations === 0
            ? 0
            : this.metrics.successfulOperations / this.metrics.totalOperations;
    }
}
export class RetryManager {
    config;
    errorClassifier;
    activeRetries = new Map();
    monitor;
    constructor(config = {}, errorClassifier, monitor) {
        this.config = { ...DEFAULT_RECOVERY_CONFIG.retry, ...config };
        this.errorClassifier = errorClassifier || this.defaultErrorClassifier.bind(this);
        this.monitor = monitor;
    }
    async execute(operation, operationId = randomUUID()) {
        return this.executeWithRecovery(operation, { operationId });
    }
    async executeWithRecovery(operation, options = {}) {
        const startTime = Date.now();
        const retryHistory = [];
        const operationId = options.operationId ?? randomUUID();
        let lastError;
        let usedFallback = false;
        for (let attempt = 1; attempt <= this.config.maxRetries + 1; attempt++) {
            let delayMs = 0;
            try {
                if (this.getActiveRetryCount() >= DEFAULT_RECOVERY_CONFIG.safety.maxConcurrentRetries) {
                    throw new SafetyRecoveryError('Max concurrent retries exceeded', 'MAX_CONCURRENT_RETRIES');
                }
                this.incrementActiveRetry(operationId);
                const value = await this.runAttempt(operation, options.timeoutMs);
                if (options.validateResult && !options.validateResult(value)) {
                    throw new PermanentRecoveryError('State validation failed', 'STATE_VALIDATION_FAILED');
                }
                const result = {
                    success: true,
                    value,
                    attempts: attempt,
                    durationMs: Date.now() - startTime,
                    retryHistory,
                };
                this.monitor?.recordOperation(true, attempt);
                if (usedFallback)
                    this.monitor?.recordRecovered();
                return result;
            }
            catch (error) {
                lastError = error;
                const classified = this.classifyError(error);
                this.monitor?.recordFailure(classified.category);
                delayMs = attempt <= this.config.maxRetries ? this.calculateDelay(attempt) : 0;
                retryHistory.push({
                    attemptNumber: attempt,
                    timestamp: Date.now(),
                    error,
                    delayMs,
                });
                const shouldRetry = attempt <= this.config.maxRetries && classified.retryable && classified.category !== 'safety';
                if (!shouldRetry) {
                    break;
                }
                await this.cleanup(options.cleanup);
                await this.sleep(delayMs);
            }
            finally {
                this.decrementActiveRetry(operationId);
            }
        }
        if (options.fallback) {
            try {
                const value = await options.fallback();
                if (options.validateResult && !options.validateResult(value)) {
                    throw new PermanentRecoveryError('Fallback validation failed', 'FALLBACK_VALIDATION_FAILED');
                }
                usedFallback = true;
                this.monitor?.recordFallback();
                this.monitor?.recordRecovered();
                this.monitor?.recordOperation(true, retryHistory.length || 1);
                return {
                    success: true,
                    value,
                    attempts: retryHistory.length || 1,
                    durationMs: Date.now() - startTime,
                    retryHistory,
                };
            }
            catch (fallbackError) {
                lastError = fallbackError;
            }
        }
        this.monitor?.recordOperation(false, retryHistory.length || 1);
        return {
            success: false,
            error: lastError,
            attempts: retryHistory.length || 1,
            durationMs: Date.now() - startTime,
            retryHistory,
        };
    }
    classifyError(error) {
        if (error instanceof RecoveryError) {
            return {
                category: error.category,
                error,
                reason: error.message,
                timestamp: Date.now(),
                retryable: error.retryable,
            };
        }
        const category = this.errorClassifier(error);
        const reason = this.extractErrorMessage(error);
        return {
            category,
            error,
            reason,
            timestamp: Date.now(),
            retryable: category === 'transient' || category === 'unknown',
        };
    }
    calculateDelay(attempt) {
        const exponentialDelay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
        const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
        if (!this.config.jitter)
            return cappedDelay;
        const jitter = cappedDelay * 0.25;
        return Math.max(0, cappedDelay + (Math.random() * jitter * 2 - jitter));
    }
    updateConfig(config) {
        this.config = { ...this.config, ...config };
    }
    getConfig() {
        return { ...this.config };
    }
    async runAttempt(operation, timeoutMs) {
        if (!timeoutMs || timeoutMs <= 0)
            return operation();
        return await Promise.race([
            operation(),
            new Promise((_, reject) => setTimeout(() => reject(new TimeoutRecoveryError()), timeoutMs)),
        ]);
    }
    defaultErrorClassifier(error) {
        if (error instanceof RecoveryError)
            return error.category;
        if (error instanceof Error) {
            const message = error.message.toLowerCase();
            const code = String(error.code ?? '');
            if (/memory limit|resource exhausted|infinite loop|max concurrent|state validation/.test(message)) {
                return 'safety';
            }
            if (this.config.retryableErrors.some((candidate) => candidate === code || message.includes(candidate.toLowerCase())) ||
                /timeout|timed out|rate limit|temporar|econnrefused|econnreset|service unavailable|network/i.test(message)) {
                return 'transient';
            }
            if (/syntax error|type error|reference error|not found|invalid|unsupported|permission denied/i.test(message)) {
                return 'permanent';
            }
        }
        return 'unknown';
    }
    extractErrorMessage(error) {
        return error instanceof Error ? error.message : String(error);
    }
    async cleanup(cleanup) {
        if (!cleanup)
            return;
        await cleanup();
    }
    sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }
    getActiveRetryCount() {
        return Array.from(this.activeRetries.values()).reduce((total, count) => total + count, 0);
    }
    incrementActiveRetry(operationId) {
        this.activeRetries.set(operationId, (this.activeRetries.get(operationId) || 0) + 1);
    }
    decrementActiveRetry(operationId) {
        const current = this.activeRetries.get(operationId) || 0;
        if (current <= 1)
            this.activeRetries.delete(operationId);
        else
            this.activeRetries.set(operationId, current - 1);
    }
}
export class CircuitBreakerOpenError extends Error {
    constructor(message) {
        super(message);
        this.name = 'CircuitBreakerOpenError';
    }
}
export class CircuitBreaker {
    config;
    state = 'CLOSED';
    consecutiveFailures = 0;
    consecutiveSuccesses = 0;
    totalSuccesses = 0;
    totalFailures = 0;
    lastFailureTime;
    openedAt;
    stateChangeListeners = [];
    monitor;
    constructor(config = {}, monitor) {
        this.config = { ...DEFAULT_RECOVERY_CONFIG.circuitBreaker, ...config };
        this.monitor = monitor;
    }
    async call(operation) {
        if (this.state === 'OPEN') {
            if (this.openedAt && Date.now() - this.openedAt >= this.config.timeoutMs) {
                this.transitionTo('HALF_OPEN', 'Timeout elapsed, attempting recovery');
            }
            else {
                throw new CircuitBreakerOpenError('Circuit breaker is OPEN');
            }
        }
        try {
            const result = await operation();
            this.recordSuccess();
            return result;
        }
        catch (error) {
            this.recordFailure();
            throw error;
        }
    }
    recordSuccess() {
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses++;
        this.totalSuccesses++;
        if (this.state === 'HALF_OPEN' && this.consecutiveSuccesses >= this.config.successThreshold) {
            this.transitionTo('CLOSED', 'Success threshold reached');
        }
    }
    recordFailure() {
        this.consecutiveFailures++;
        this.consecutiveSuccesses = 0;
        this.totalFailures++;
        this.lastFailureTime = Date.now();
        if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.config.failureThreshold) {
            this.transitionTo('OPEN', 'Failure threshold exceeded');
            this.openedAt = Date.now();
            this.monitor?.recordCircuitOpened();
        }
    }
    getState() {
        return this.state;
    }
    getStats() {
        return {
            state: this.state,
            consecutiveFailures: this.consecutiveFailures,
            consecutiveSuccesses: this.consecutiveSuccesses,
            totalSuccesses: this.totalSuccesses,
            totalFailures: this.totalFailures,
            lastFailureTime: this.lastFailureTime,
            openedAt: this.openedAt,
        };
    }
    reset() {
        this.transitionTo('CLOSED', 'Manual reset');
        this.consecutiveFailures = 0;
        this.consecutiveSuccesses = 0;
        this.openedAt = undefined;
    }
    onStateChange(callback) {
        this.stateChangeListeners.push(callback);
    }
    transitionTo(newState, reason) {
        const from = this.state;
        this.state = newState;
        const event = { from, to: newState, timestamp: Date.now(), reason };
        for (const listener of this.stateChangeListeners)
            listener(event);
    }
}
export class SafetyGuardian {
    config;
    loopPatterns = new Map();
    taskRetryCounts = new Map();
    startTimes = new Map();
    monitor;
    constructor(config = {}, monitor) {
        this.config = { ...DEFAULT_RECOVERY_CONFIG.safety, ...config };
        this.monitor = monitor;
    }
    checkLimits(context) {
        const violations = [];
        const taskRetryCount = this.getTaskRetryCount(context.taskId);
        if (taskRetryCount >= this.config.maxRetriesPerTask) {
            violations.push({
                guardrail: 'maxRetriesPerTask',
                current: taskRetryCount,
                limit: this.config.maxRetriesPerTask,
                severity: 'critical',
                description: `Task retry count (${taskRetryCount}) exceeded limit`,
            });
        }
        if (context.activeRetries >= this.config.maxConcurrentRetries) {
            violations.push({
                guardrail: 'maxConcurrentRetries',
                current: context.activeRetries,
                limit: this.config.maxConcurrentRetries,
                severity: 'critical',
                description: 'Max concurrent retries exceeded',
            });
        }
        const elapsedMs = this.getElapsedTime(context.taskId);
        if (elapsedMs >= this.config.totalTimeoutMs) {
            violations.push({
                guardrail: 'totalTimeoutMs',
                current: elapsedMs,
                limit: this.config.totalTimeoutMs,
                severity: 'critical',
                description: `Task timeout (${elapsedMs}ms) exceeded limit`,
            });
        }
        if (context.memoryMb && context.memoryMb >= this.config.memoryLimitMb) {
            violations.push({
                guardrail: 'memoryLimitMb',
                current: context.memoryMb,
                limit: this.config.memoryLimitMb,
                severity: 'warning',
                description: `Memory usage (${context.memoryMb}MB) approaching limit`,
            });
        }
        const check = {
            passed: violations.length === 0,
            violations,
            resources: {
                memoryMb: context.memoryMb || 0,
                activeRetries: context.activeRetries,
                taskRetryCount,
                elapsedMs,
            },
        };
        for (const violation of violations) {
            this.monitor?.alert(violation.severity === 'critical' ? 'critical' : 'medium', violation.guardrail, violation.description, context.taskId);
        }
        return check;
    }
    enforceGuardrails(context) {
        return this.checkLimits(context).violations.every((violation) => violation.severity !== 'critical');
    }
    detectLoop(patternSignature) {
        if (!this.config.enableLoopDetection)
            return false;
        const now = Date.now();
        const existing = this.loopPatterns.get(patternSignature);
        if (existing) {
            existing.occurrences++;
            existing.lastSeen = now;
            if (existing.occurrences >= 3 && now - existing.firstSeen < 60000)
                return true;
        }
        else {
            this.loopPatterns.set(patternSignature, {
                signature: patternSignature,
                occurrences: 1,
                firstSeen: now,
                lastSeen: now,
            });
        }
        return false;
    }
    validateState(value, validator) {
        return validator ? validator(value) : true;
    }
    incrementTaskRetry(taskId) {
        this.taskRetryCounts.set(taskId, (this.taskRetryCounts.get(taskId) || 0) + 1);
        if (!this.startTimes.has(taskId))
            this.startTimes.set(taskId, Date.now());
    }
    clearTask(taskId) {
        this.taskRetryCounts.delete(taskId);
        this.startTimes.delete(taskId);
    }
    getTaskRetryCount(taskId) {
        return this.taskRetryCounts.get(taskId) || 0;
    }
    getElapsedTime(taskId) {
        const start = this.startTimes.get(taskId);
        return start ? Date.now() - start : 0;
    }
}
export class RollbackManager {
    plans = new Map();
    monitor;
    constructor(monitor) {
        this.monitor = monitor;
    }
    register(plan) {
        this.plans.set(plan.checkpointId, plan);
    }
    async rollbackToCheckpoint(checkpointId) {
        const plan = this.plans.get(checkpointId);
        if (!plan) {
            this.monitor?.recordRollback(false);
            throw new PermanentRecoveryError(`Unknown checkpoint: ${checkpointId}`, 'UNKNOWN_CHECKPOINT');
        }
        const rolledBackSteps = [];
        const failedStepIds = [];
        for (const step of [...plan.steps].reverse()) {
            try {
                await step.rollback();
                if (step.verify) {
                    const valid = await step.verify();
                    if (!valid)
                        throw new Error(`Verification failed for ${step.id}`);
                }
                rolledBackSteps.push(step.id);
            }
            catch {
                failedStepIds.push(step.id);
            }
        }
        if (plan.restoreState)
            await plan.restoreState();
        const verificationPassed = plan.verifyRestoration ? await plan.verifyRestoration() : failedStepIds.length === 0;
        const success = failedStepIds.length === 0 && verificationPassed;
        this.monitor?.recordRollback(success);
        return {
            success,
            checkpointId,
            rolledBackSteps,
            failedStepIds,
            verificationPassed,
            partial: rolledBackSteps.length > 0 && failedStepIds.length > 0,
        };
    }
}
export class RecoveryEngine {
    retryManager;
    circuitBreaker;
    safetyGuardian;
    rollbackManager;
    monitor;
    hooks = [];
    recoveryHistory = new Map();
    constructor(config = {}) {
        this.monitor = new RecoveryMonitor();
        this.retryManager = new RetryManager(config.retry, undefined, this.monitor);
        this.circuitBreaker = new CircuitBreaker(config.circuitBreaker, this.monitor);
        this.safetyGuardian = new SafetyGuardian(config.safety, this.monitor);
        this.rollbackManager = new RollbackManager(this.monitor);
    }
    async executeWithRecovery(operation, options = {}) {
        return this.circuitBreaker.call(() => this.retryManager.executeWithRecovery(operation, options));
    }
    async attemptRecovery(context) {
        const alerts = [];
        const safetyCheck = this.safetyGuardian.checkLimits({
            taskId: context.taskId,
            activeRetries: context.attemptHistory.length,
        });
        if (!safetyCheck.passed) {
            const message = `Safety violations: ${safetyCheck.violations.map((v) => v.description).join(', ')}`;
            const alert = this.monitor.alert('critical', 'SAFETY_GUARDRAIL_TRIGGERED', message, context.taskId);
            alerts.push(alert);
            const result = {
                success: false,
                action: 'halt',
                message,
                alerts,
                metrics: this.monitor.getMetrics(),
            };
            this.recoveryHistory.set(context.taskId, result);
            await this.executeHooks(context, result);
            return result;
        }
        const loopDetected = this.safetyGuardian.detectLoop(this.buildLoopSignature(context));
        if (loopDetected) {
            const message = `Retry loop detected for task ${context.taskId}`;
            const alert = this.monitor.alert('critical', 'RETRY_LOOP_DETECTED', message, context.taskId);
            alerts.push(alert);
            const result = {
                success: false,
                action: 'halt',
                message,
                alerts,
                metrics: this.monitor.getMetrics(),
            };
            this.recoveryHistory.set(context.taskId, result);
            await this.executeHooks(context, result);
            return result;
        }
        let result;
        switch (context.failure.category) {
            case 'transient':
                this.safetyGuardian.incrementTaskRetry(context.taskId);
                result = {
                    success: true,
                    action: 'retry',
                    newState: 'repair',
                    message: `Transient failure detected, retrying with backoff. Remaining: ${Math.max(0, context.remainingRetries - 1)}`,
                };
                break;
            case 'permanent':
                result = await this.handlePermanentFailure(context);
                break;
            case 'safety':
                alerts.push(this.monitor.alert('critical', 'SAFETY_FAILURE', context.failure.reason, context.taskId));
                result = {
                    success: false,
                    action: 'halt',
                    message: `Safety violation: ${context.failure.reason}`,
                    alerts,
                };
                break;
            default:
                result = context.remainingRetries > 0
                    ? {
                        success: true,
                        action: 'retry',
                        newState: 'repair',
                        message: `Unknown failure treated as retryable. Remaining: ${Math.max(0, context.remainingRetries - 1)}`,
                    }
                    : await this.handlePermanentFailure(context);
                break;
        }
        result.alerts = [...(result.alerts ?? []), ...alerts];
        result.metrics = this.monitor.getMetrics();
        this.recoveryHistory.set(context.taskId, result);
        await this.executeHooks(context, result);
        return result;
    }
    async rollbackToCheckpoint(sessionId, checkpointId) {
        void sessionId;
        const result = await this.rollbackManager.rollbackToCheckpoint(checkpointId);
        return result.success;
    }
    async escalateToReasoner(context) {
        return {
            targetModel: context.targetModel ?? 'gpt54',
            reason: context.reason,
            contextSummary: `Task ${context.taskId} escalated for advanced recovery analysis`,
            escalatedAt: Date.now(),
        };
    }
    registerRollbackPlan(plan) {
        this.rollbackManager.register(plan);
    }
    registerHook(hook) {
        this.hooks.push(hook);
    }
    getRetryManager() { return this.retryManager; }
    getCircuitBreaker() { return this.circuitBreaker; }
    getSafetyGuardian() { return this.safetyGuardian; }
    getRollbackManager() { return this.rollbackManager; }
    getMonitor() { return this.monitor; }
    getRecoveryHistory(taskId) { return this.recoveryHistory.get(taskId); }
    async handlePermanentFailure(context) {
        if (context.lastCheckpointId) {
            const rollbackResult = await this.rollbackManager.rollbackToCheckpoint(context.lastCheckpointId);
            return {
                success: rollbackResult.success,
                action: 'rollback',
                newState: rollbackResult.success ? 'repair' : 'error',
                rollbackCheckpointId: context.lastCheckpointId,
                rollbackResult,
                message: rollbackResult.success
                    ? `Permanent failure, rolled back to checkpoint ${context.lastCheckpointId}`
                    : `Permanent failure, rollback partially failed for checkpoint ${context.lastCheckpointId}`,
            };
        }
        const escalation = await this.escalateToReasoner({ taskId: context.taskId, reason: context.failure.reason });
        this.monitor.alert('high', 'RECOVERY_ESCALATION', escalation.reason, context.taskId);
        return {
            success: false,
            action: 'escalate',
            newState: 'error',
            escalation,
            message: `Escalating to ${escalation.targetModel}: ${escalation.reason}`,
        };
    }
    buildLoopSignature(context) {
        return [
            context.taskId,
            context.currentState,
            context.failure.category,
            context.failure.reason,
            String(context.lastCheckpointId ?? 'none'),
        ].join('|');
    }
    async executeHooks(context, result) {
        for (const hook of this.hooks) {
            try {
                await hook(context, result);
            }
            catch (error) {
                console.error('Recovery hook failed:', error);
            }
        }
    }
}
export const recoveryEngine = new RecoveryEngine();
export function createRecoveryEngine(config) {
    return new RecoveryEngine(config);
}

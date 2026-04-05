/**
 * Thread 19: Recovery, Retry, Safety, Rollback, and Monitoring
 */

import { randomUUID } from 'crypto';
import type {
  FailureCategory,
  CircuitState,
  RetryConfig,
  CircuitBreakerConfig,
  SafetyConfig,
  RecoveryConfig,
  ClassifiedFailure,
  RetryAttempt,
  RetryResult,
  CircuitStats,
  SafetyCheck,
  SafetyViolation,
  ResourceSnapshot,
  RecoveryContext,
  RecoveryResult,
  EscalationInfo,
  LoopPattern,
  Operation,
  ErrorClassifier,
  RecoveryHook,
  CircuitBreakerEvent,
} from '../types/repairer.ts';
import { DEFAULT_RECOVERY_CONFIG } from '../types/repairer.ts';

export type ErrorSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface RecoveryAlert {
  level: ErrorSeverity;
  code: string;
  message: string;
  timestamp: number;
  taskId?: string;
}

export interface RecoveryMetrics {
  totalOperations: number;
  successfulOperations: number;
  failedOperations: number;
  retriedOperations: number;
  recoveredOperations: number;
  fallbackActivations: number;
  rollbackAttempts: number;
  rollbackSuccesses: number;
  circuitOpenEvents: number;
  alerts: RecoveryAlert[];
  failuresByCategory: Record<FailureCategory, number>;
  averageAttempts: number;
  successRate: number;
}

export interface ExecuteWithRecoveryOptions<T> {
  operationId?: string;
  taskId?: string;
  timeoutMs?: number;
  fallback?: () => Promise<T> | T;
  cleanup?: () => Promise<void> | void;
  validateResult?: (value: T) => boolean;
}

export interface RollbackStep {
  id: string;
  apply: () => Promise<void> | void;
  rollback: () => Promise<void> | void;
  verify?: () => Promise<boolean> | boolean;
}

export interface RollbackPlan {
  checkpointId: string;
  steps: RollbackStep[];
  restoreState?: () => Promise<void> | void;
  verifyRestoration?: () => Promise<boolean> | boolean;
}

export interface RollbackResult {
  success: boolean;
  checkpointId: string;
  rolledBackSteps: string[];
  failedStepIds: string[];
  verificationPassed: boolean;
  partial: boolean;
}

export interface ExtendedRecoveryResult extends RecoveryResult {
  metrics?: RecoveryMetrics;
  alerts?: RecoveryAlert[];
  rollbackResult?: RollbackResult;
}

export class RecoveryError extends Error {
  readonly category: FailureCategory;
  readonly severity: ErrorSeverity;
  readonly retryable: boolean;
  readonly code?: string;

  constructor(message: string, options: {
    category: FailureCategory;
    severity?: ErrorSeverity;
    retryable?: boolean;
    code?: string;
  }) {
    super(message);
    this.name = 'RecoveryError';
    this.category = options.category;
    this.severity = options.severity ?? 'medium';
    this.retryable = options.retryable ?? options.category === 'transient';
    this.code = options.code;
  }
}

export class TransientRecoveryError extends RecoveryError {
  constructor(message: string, code?: string) {
    super(message, { category: 'transient', severity: 'medium', retryable: true, code });
    this.name = 'TransientRecoveryError';
  }
}

export class PermanentRecoveryError extends RecoveryError {
  constructor(message: string, code?: string) {
    super(message, { category: 'permanent', severity: 'high', retryable: false, code });
    this.name = 'PermanentRecoveryError';
  }
}

export class SafetyRecoveryError extends RecoveryError {
  constructor(message: string, code?: string) {
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
  private metrics: RecoveryMetrics = {
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

  recordOperation(success: boolean, attempts: number): void {
    this.metrics.totalOperations++;
    if (success) this.metrics.successfulOperations++;
    else this.metrics.failedOperations++;
    if (attempts > 1) this.metrics.retriedOperations++;
    this.refreshDerivedMetrics(attempts);
  }

  recordRecovered(): void {
    this.metrics.recoveredOperations++;
  }

  recordFailure(category: FailureCategory): void {
    this.metrics.failuresByCategory[category]++;
  }

  recordFallback(): void {
    this.metrics.fallbackActivations++;
  }

  recordCircuitOpened(): void {
    this.metrics.circuitOpenEvents++;
  }

  recordRollback(success: boolean): void {
    this.metrics.rollbackAttempts++;
    if (success) this.metrics.rollbackSuccesses++;
  }

  alert(level: ErrorSeverity, code: string, message: string, taskId?: string): RecoveryAlert {
    const alert = { level, code, message, timestamp: Date.now(), taskId };
    this.metrics.alerts.push(alert);
    return alert;
  }

  analyzeFailures(): Array<{ category: FailureCategory; count: number }> {
    return Object.entries(this.metrics.failuresByCategory)
      .map(([category, count]) => ({ category: category as FailureCategory, count }))
      .sort((a, b) => b.count - a.count);
  }

  getMetrics(): RecoveryMetrics {
    return {
      ...this.metrics,
      alerts: [...this.metrics.alerts],
      failuresByCategory: { ...this.metrics.failuresByCategory },
    };
  }

  private refreshDerivedMetrics(lastAttempts: number): void {
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
  private config: RetryConfig;
  private errorClassifier: ErrorClassifier;
  private activeRetries: Map<string, number> = new Map();
  private monitor?: RecoveryMonitor;

  constructor(
    config: Partial<RetryConfig> = {},
    errorClassifier?: ErrorClassifier,
    monitor?: RecoveryMonitor
  ) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.retry, ...config };
    this.errorClassifier = errorClassifier || this.defaultErrorClassifier.bind(this);
    this.monitor = monitor;
  }

  async execute<T>(operation: Operation<T>, operationId: string = randomUUID()): Promise<RetryResult<T>> {
    return this.executeWithRecovery(operation, { operationId });
  }

  async executeWithRecovery<T>(
    operation: Operation<T>,
    options: ExecuteWithRecoveryOptions<T> = {}
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    const retryHistory: RetryAttempt[] = [];
    const operationId = options.operationId ?? randomUUID();
    let lastError: unknown;
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

        const result: RetryResult<T> = {
          success: true,
          value,
          attempts: attempt,
          durationMs: Date.now() - startTime,
          retryHistory,
        };
        this.monitor?.recordOperation(true, attempt);
        if (usedFallback) this.monitor?.recordRecovered();
        return result;
      } catch (error) {
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
      } finally {
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
      } catch (fallbackError) {
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

  classifyError(error: unknown): ClassifiedFailure {
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

  calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);
    if (!this.config.jitter) return cappedDelay;
    const jitter = cappedDelay * 0.25;
    return Math.max(0, cappedDelay + (Math.random() * jitter * 2 - jitter));
  }

  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): RetryConfig {
    return { ...this.config };
  }

  private async runAttempt<T>(operation: Operation<T>, timeoutMs?: number): Promise<T> {
    if (!timeoutMs || timeoutMs <= 0) return operation();
    return await Promise.race<T>([
      operation(),
      new Promise<T>((_, reject) => setTimeout(() => reject(new TimeoutRecoveryError()), timeoutMs)),
    ]);
  }

  private defaultErrorClassifier(error: unknown): FailureCategory {
    if (error instanceof RecoveryError) return error.category;
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      const code = String((error as { code?: string }).code ?? '');

      if (/memory limit|resource exhausted|infinite loop|max concurrent|state validation/.test(message)) {
        return 'safety';
      }
      if (
        this.config.retryableErrors.some((candidate) => candidate === code || message.includes(candidate.toLowerCase())) ||
        /timeout|timed out|rate limit|temporar|econnrefused|econnreset|service unavailable|network/i.test(message)
      ) {
        return 'transient';
      }
      if (/syntax error|type error|reference error|not found|invalid|unsupported|permission denied/i.test(message)) {
        return 'permanent';
      }
    }
    return 'unknown';
  }

  private extractErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private async cleanup(cleanup?: () => Promise<void> | void): Promise<void> {
    if (!cleanup) return;
    await cleanup();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getActiveRetryCount(): number {
    return Array.from(this.activeRetries.values()).reduce((total, count) => total + count, 0);
  }

  private incrementActiveRetry(operationId: string): void {
    this.activeRetries.set(operationId, (this.activeRetries.get(operationId) || 0) + 1);
  }

  private decrementActiveRetry(operationId: string): void {
    const current = this.activeRetries.get(operationId) || 0;
    if (current <= 1) this.activeRetries.delete(operationId);
    else this.activeRetries.set(operationId, current - 1);
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private lastFailureTime?: number;
  private openedAt?: number;
  private stateChangeListeners: Array<(event: CircuitBreakerEvent) => void> = [];
  private monitor?: RecoveryMonitor;

  constructor(config: Partial<CircuitBreakerConfig> = {}, monitor?: RecoveryMonitor) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.circuitBreaker, ...config };
    this.monitor = monitor;
  }

  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.openedAt && Date.now() - this.openedAt >= this.config.timeoutMs) {
        this.transitionTo('HALF_OPEN', 'Timeout elapsed, attempting recovery');
      } else {
        throw new CircuitBreakerOpenError('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    this.totalSuccesses++;
    if (this.state === 'HALF_OPEN' && this.consecutiveSuccesses >= this.config.successThreshold) {
      this.transitionTo('CLOSED', 'Success threshold reached');
    }
  }

  recordFailure(): void {
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

  getState(): CircuitState {
    return this.state;
  }

  getStats(): CircuitStats {
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

  reset(): void {
    this.transitionTo('CLOSED', 'Manual reset');
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = undefined;
  }

  onStateChange(callback: (event: CircuitBreakerEvent) => void): void {
    this.stateChangeListeners.push(callback);
  }

  private transitionTo(newState: CircuitState, reason: string): void {
    const from = this.state;
    this.state = newState;
    const event: CircuitBreakerEvent = { from, to: newState, timestamp: Date.now(), reason };
    for (const listener of this.stateChangeListeners) listener(event);
  }
}

export class SafetyGuardian {
  private config: SafetyConfig;
  private loopPatterns: Map<string, LoopPattern> = new Map();
  private taskRetryCounts: Map<string, number> = new Map();
  private startTimes: Map<string, number> = new Map();
  private monitor?: RecoveryMonitor;

  constructor(config: Partial<SafetyConfig> = {}, monitor?: RecoveryMonitor) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.safety, ...config };
    this.monitor = monitor;
  }

  checkLimits(context: { taskId: string; activeRetries: number; memoryMb?: number }): SafetyCheck {
    const violations: SafetyViolation[] = [];
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
      } satisfies ResourceSnapshot,
    } satisfies SafetyCheck;

    for (const violation of violations) {
      this.monitor?.alert(violation.severity === 'critical' ? 'critical' : 'medium', violation.guardrail, violation.description, context.taskId);
    }
    return check;
  }

  enforceGuardrails(context: { taskId: string; activeRetries: number; memoryMb?: number }): boolean {
    return this.checkLimits(context).violations.every((violation) => violation.severity !== 'critical');
  }

  detectLoop(patternSignature: string): boolean {
    if (!this.config.enableLoopDetection) return false;
    const now = Date.now();
    const existing = this.loopPatterns.get(patternSignature);
    if (existing) {
      existing.occurrences++;
      existing.lastSeen = now;
      if (existing.occurrences >= 3 && now - existing.firstSeen < 60000) return true;
    } else {
      this.loopPatterns.set(patternSignature, {
        signature: patternSignature,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }
    return false;
  }

  validateState<T>(value: T, validator?: (value: T) => boolean): boolean {
    return validator ? validator(value) : true;
  }

  incrementTaskRetry(taskId: string): void {
    this.taskRetryCounts.set(taskId, (this.taskRetryCounts.get(taskId) || 0) + 1);
    if (!this.startTimes.has(taskId)) this.startTimes.set(taskId, Date.now());
  }

  clearTask(taskId: string): void {
    this.taskRetryCounts.delete(taskId);
    this.startTimes.delete(taskId);
  }

  private getTaskRetryCount(taskId: string): number {
    return this.taskRetryCounts.get(taskId) || 0;
  }

  private getElapsedTime(taskId: string): number {
    const start = this.startTimes.get(taskId);
    return start ? Date.now() - start : 0;
  }
}

export class RollbackManager {
  private plans = new Map<string, RollbackPlan>();
  private monitor?: RecoveryMonitor;

  constructor(monitor?: RecoveryMonitor) {
    this.monitor = monitor;
  }

  register(plan: RollbackPlan): void {
    this.plans.set(plan.checkpointId, plan);
  }

  async rollbackToCheckpoint(checkpointId: string): Promise<RollbackResult> {
    const plan = this.plans.get(checkpointId);
    if (!plan) {
      this.monitor?.recordRollback(false);
      throw new PermanentRecoveryError(`Unknown checkpoint: ${checkpointId}`, 'UNKNOWN_CHECKPOINT');
    }

    const rolledBackSteps: string[] = [];
    const failedStepIds: string[] = [];

    for (const step of [...plan.steps].reverse()) {
      try {
        await step.rollback();
        if (step.verify) {
          const valid = await step.verify();
          if (!valid) throw new Error(`Verification failed for ${step.id}`);
        }
        rolledBackSteps.push(step.id);
      } catch {
        failedStepIds.push(step.id);
      }
    }

    if (plan.restoreState) await plan.restoreState();
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
  private retryManager: RetryManager;
  private circuitBreaker: CircuitBreaker;
  private safetyGuardian: SafetyGuardian;
  private rollbackManager: RollbackManager;
  private monitor: RecoveryMonitor;
  private hooks: RecoveryHook[] = [];
  private recoveryHistory: Map<string, ExtendedRecoveryResult> = new Map();

  constructor(config: Partial<RecoveryConfig> = {}) {
    this.monitor = new RecoveryMonitor();
    this.retryManager = new RetryManager(config.retry, undefined, this.monitor);
    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker, this.monitor);
    this.safetyGuardian = new SafetyGuardian(config.safety, this.monitor);
    this.rollbackManager = new RollbackManager(this.monitor);
  }

  async executeWithRecovery<T>(operation: Operation<T>, options: ExecuteWithRecoveryOptions<T> = {}): Promise<RetryResult<T>> {
    return this.circuitBreaker.call(() => this.retryManager.executeWithRecovery(operation, options));
  }

  async attemptRecovery(context: RecoveryContext): Promise<ExtendedRecoveryResult> {
    const alerts: RecoveryAlert[] = [];
    const safetyCheck = this.safetyGuardian.checkLimits({
      taskId: context.taskId,
      activeRetries: context.attemptHistory.length,
    });

    if (!safetyCheck.passed) {
      const message = `Safety violations: ${safetyCheck.violations.map((v) => v.description).join(', ')}`;
      const alert = this.monitor.alert('critical', 'SAFETY_GUARDRAIL_TRIGGERED', message, context.taskId);
      alerts.push(alert);
      const result: ExtendedRecoveryResult = {
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
      const result: ExtendedRecoveryResult = {
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

    let result: ExtendedRecoveryResult;
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

  async rollbackToCheckpoint(sessionId: string, checkpointId: string): Promise<boolean> {
    void sessionId;
    const result = await this.rollbackManager.rollbackToCheckpoint(checkpointId);
    return result.success;
  }

  async escalateToReasoner(context: { taskId: string; reason: string; targetModel?: string }): Promise<EscalationInfo> {
    return {
      targetModel: context.targetModel ?? 'deepseek-reasoner',
      reason: context.reason,
      contextSummary: `Task ${context.taskId} escalated for advanced recovery analysis`,
      escalatedAt: Date.now(),
    };
  }

  registerRollbackPlan(plan: RollbackPlan): void {
    this.rollbackManager.register(plan);
  }

  registerHook(hook: RecoveryHook): void {
    this.hooks.push(hook);
  }

  getRetryManager(): RetryManager { return this.retryManager; }
  getCircuitBreaker(): CircuitBreaker { return this.circuitBreaker; }
  getSafetyGuardian(): SafetyGuardian { return this.safetyGuardian; }
  getRollbackManager(): RollbackManager { return this.rollbackManager; }
  getMonitor(): RecoveryMonitor { return this.monitor; }
  getRecoveryHistory(taskId: string): ExtendedRecoveryResult | undefined { return this.recoveryHistory.get(taskId); }

  private async handlePermanentFailure(context: RecoveryContext): Promise<ExtendedRecoveryResult> {
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

  private buildLoopSignature(context: RecoveryContext): string {
    return [
      context.taskId,
      context.currentState,
      context.failure.category,
      context.failure.reason,
      String(context.lastCheckpointId ?? 'none'),
    ].join('|');
  }

  private async executeHooks(context: RecoveryContext, result: RecoveryResult): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook(context, result);
      } catch (error) {
        console.error('Recovery hook failed:', error);
      }
    }
  }
}

export const recoveryEngine = new RecoveryEngine();
export function createRecoveryEngine(config?: Partial<RecoveryConfig>): RecoveryEngine {
  return new RecoveryEngine(config);
}

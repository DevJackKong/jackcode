/**
 * Thread 19: Recovery-Retry-Safety
 * Resilience, retry logic, and safety guardrails for JackCode
 */

import { randomUUID } from 'crypto';
import type {
  FailureCategory,
  CircuitState,
  RecoveryLevel,
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
  DEFAULT_RECOVERY_CONFIG,
} from '../types/repairer.js';

/**
 * Retry Manager
 * Handles exponential backoff with jitter for transient failures
 */
export class RetryManager {
  private config: RetryConfig;
  private errorClassifier: ErrorClassifier;
  private activeRetries: Map<string, number> = new Map();

  constructor(
    config: Partial<RetryConfig> = {},
    errorClassifier?: ErrorClassifier
  ) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.retry, ...config };
    this.errorClassifier =
      errorClassifier || this.defaultErrorClassifier.bind(this);
  }

  /**
   * Execute operation with retry logic
   */
  async execute<T>(
    operation: Operation<T>,
    operationId: string = randomUUID()
  ): Promise<RetryResult<T>> {
    const startTime = Date.now();
    const retryHistory: RetryAttempt[] = [];
    let lastError: unknown;

    const maxRetries = this.config.maxRetries;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const attemptStart = Date.now();

      try {
        // Check concurrent retry limit
        const activeCount = this.getActiveRetryCount();
        if (activeCount >= DEFAULT_RECOVERY_CONFIG.safety.maxConcurrentRetries) {
          throw new Error('Max concurrent retries exceeded');
        }

        this.incrementActiveRetry(operationId);
        const result = await operation();
        this.decrementActiveRetry(operationId);

        const durationMs = Date.now() - startTime;

        return {
          success: true,
          value: result,
          attempts: attempt,
          durationMs,
          retryHistory,
        };
      } catch (error) {
        this.decrementActiveRetry(operationId);
        lastError = error;

        const category = this.errorClassifier(error);

        // Record attempt
        retryHistory.push({
          attemptNumber: attempt,
          timestamp: Date.now(),
          error,
          delayMs: attempt > 1 ? this.calculateDelay(attempt - 1) : 0,
        });

        // Don't retry if max reached or not retryable
        if (attempt > maxRetries || category === 'permanent' || category === 'safety') {
          break;
        }

        // Calculate and apply backoff delay
        if (attempt <= maxRetries) {
          const delayMs = this.calculateDelay(attempt);
          await this.sleep(delayMs);
        }
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      success: false,
      error: lastError,
      attempts: retryHistory.length,
      durationMs,
      retryHistory,
    };
  }

  /**
   * Classify error into failure category
   */
  classifyError(error: unknown): ClassifiedFailure {
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

  /**
   * Calculate backoff delay with jitter
   */
  calculateDelay(attempt: number): number {
    const exponentialDelay =
      this.config.baseDelayMs *
      Math.pow(this.config.backoffMultiplier, attempt - 1);

    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);

    if (this.config.jitter) {
      // Add ±25% jitter
      const jitter = cappedDelay * 0.25;
      return Math.max(0, cappedDelay + (Math.random() * jitter * 2 - jitter));
    }

    return cappedDelay;
  }

  /**
   * Default error classifier
   */
  private defaultErrorClassifier(error: unknown): FailureCategory {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      const code = (error as { code?: string }).code;

      // Safety violations
      if (
        message.includes('memory limit') ||
        message.includes('infinite loop') ||
        message.includes('max concurrent')
      ) {
        return 'safety';
      }

      // Retryable errors
      if (
        this.config.retryableErrors.some(
          (e) => message.includes(e.toLowerCase()) || code === e
        ) ||
        message.includes('timeout') ||
        message.includes('rate limit') ||
        message.includes('econnrefused') ||
        message.includes('econnreset')
      ) {
        return 'transient';
      }

      // Permanent errors
      if (
        message.includes('syntax error') ||
        message.includes('type error') ||
        message.includes('reference error') ||
        message.includes('not found') ||
        message.includes('invalid')
      ) {
        return 'permanent';
      }
    }

    return 'unknown';
  }

  /**
   * Extract human-readable error message
   */
  private extractErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }

  /**
   * Sleep helper
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Get active retry count
   */
  private getActiveRetryCount(): number {
    return Object.values(this.activeRetries).reduce((a, b) => a + b, 0);
  }

  /**
   * Increment active retry counter
   */
  private incrementActiveRetry(operationId: string): void {
    const current = this.activeRetries.get(operationId) || 0;
    this.activeRetries.set(operationId, current + 1);
  }

  /**
   * Decrement active retry counter
   */
  private decrementActiveRetry(operationId: string): void {
    const current = this.activeRetries.get(operationId) || 0;
    if (current > 0) {
      this.activeRetries.set(operationId, current - 1);
    }
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): RetryConfig {
    return { ...this.config };
  }
}

/**
 * Circuit Breaker
 * Prevents cascading failures by halting repeated failing operations
 */
export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private totalSuccesses: number = 0;
  private totalFailures: number = 0;
  private lastFailureTime?: number;
  private openedAt?: number;
  private stateChangeListeners: Array<(event: CircuitBreakerEvent) => void> = [];

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.circuitBreaker, ...config };
  }

  /**
   * Execute operation through circuit breaker
   */
  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      // Check if timeout elapsed for half-open
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

  /**
   * Record successful operation
   */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    this.totalSuccesses++;

    if (this.state === 'HALF_OPEN') {
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo('CLOSED', 'Success threshold reached');
      }
    }
  }

  /**
   * Record failed operation
   */
  recordFailure(): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.transitionTo('OPEN', 'Failure threshold exceeded');
      this.openedAt = Date.now();
    }
  }

  /**
   * Get current circuit state
   */
  getState(): CircuitState {
    return this.state;
  }

  /**
   * Get circuit statistics
   */
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

  /**
   * Manually reset circuit to CLOSED
   */
  reset(): void {
    this.transitionTo('CLOSED', 'Manual reset');
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = undefined;
  }

  /**
   * Subscribe to state changes
   */
  onStateChange(callback: (event: CircuitBreakerEvent) => void): void {
    this.stateChangeListeners.push(callback);
  }

  /**
   * Transition to new state
   */
  private transitionTo(newState: CircuitState, reason: string): void {
    const from = this.state;
    this.state = newState;

    const event: CircuitBreakerEvent = {
      from,
      to: newState,
      timestamp: Date.now(),
      reason,
    };

    this.stateChangeListeners.forEach((listener) => listener(event));
  }
}

/**
 * Circuit breaker open error
 */
export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

/**
 * Safety Guardian
 * Enforces safety guardrails and detects retry loops
 */
export class SafetyGuardian {
  private config: SafetyConfig;
  private loopPatterns: Map<string, LoopPattern> = new Map();
  private taskRetryCounts: Map<string, number> = new Map();
  private startTimes: Map<string, number> = new Map();

  constructor(config: Partial<SafetyConfig> = {}) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.safety, ...config };
  }

  /**
   * Check safety constraints
   */
  checkLimits(context: {
    taskId: string;
    activeRetries: number;
    memoryMb?: number;
  }): SafetyCheck {
    const violations: SafetyViolation[] = [];

    // Check task retry count
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

    // Check concurrent retry limit
    if (context.activeRetries >= this.config.maxConcurrentRetries) {
      violations.push({
        guardrail: 'maxConcurrentRetries',
        current: context.activeRetries,
        limit: this.config.maxConcurrentRetries,
        severity: 'critical',
        description: 'Max concurrent retries exceeded',
      });
    }

    // Check timeout
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

    // Check memory limit
    if (context.memoryMb && context.memoryMb >= this.config.memoryLimitMb) {
      violations.push({
        guardrail: 'memoryLimitMb',
        current: context.memoryMb,
        limit: this.config.memoryLimitMb,
        severity: 'warning',
        description: `Memory usage (${context.memoryMb}MB) approaching limit`,
      });
    }

    const resources: ResourceSnapshot = {
      memoryMb: context.memoryMb || 0,
      activeRetries: context.activeRetries,
      taskRetryCount,
      elapsedMs,
    };

    return {
      passed: violations.length === 0,
      violations,
      resources,
    };
  }

  /**
   * Enforce hard safety limits
   */
  enforceGuardrails(context: {
    taskId: string;
    activeRetries: number;
    memoryMb?: number;
  }): boolean {
    const check = this.checkLimits(context);
    const criticalViolations = check.violations.filter(
      (v) => v.severity === 'critical'
    );
    return criticalViolations.length === 0;
  }

  /**
   * Detect retry loops based on pattern
   */
  detectLoop(patternSignature: string): boolean {
    if (!this.config.enableLoopDetection) {
      return false;
    }

    const now = Date.now();
    const existing = this.loopPatterns.get(patternSignature);

    if (existing) {
      existing.occurrences++;
      existing.lastSeen = now;

      // Loop detected if pattern seen 3+ times within 60 seconds
      if (
        existing.occurrences >= 3 &&
        now - existing.firstSeen < 60000
      ) {
        return true;
      }
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

  /**
   * Increment retry count for task
   */
  incrementTaskRetry(taskId: string): void {
    const current = this.taskRetryCounts.get(taskId) || 0;
    this.taskRetryCounts.set(taskId, current + 1);

    // Initialize start time if first retry
    if (!this.startTimes.has(taskId)) {
      this.startTimes.set(taskId, Date.now());
    }
  }

  /**
   * Clear task tracking
   */
  clearTask(taskId: string): void {
    this.taskRetryCounts.delete(taskId);
    this.startTimes.delete(taskId);
  }

  /**
   * Get task retry count
   */
  private getTaskRetryCount(taskId: string): number {
    return this.taskRetryCounts.get(taskId) || 0;
  }

  /**
   * Get elapsed time for task
   */
  private getElapsedTime(taskId: string): number {
    const start = this.startTimes.get(taskId);
    if (!start) return 0;
    return Date.now() - start;
  }
}

/**
 * Recovery Engine
 * Orchestrates recovery actions based on failure classification
 */
export class RecoveryEngine {
  private retryManager: RetryManager;
  private circuitBreaker: CircuitBreaker;
  private safetyGuardian: SafetyGuardian;
  private hooks: RecoveryHook[] = [];
  private recoveryHistory: Map<string, RecoveryResult> = new Map();

  constructor(config: Partial<RecoveryConfig> = {}) {
    this.retryManager = new RetryManager(config.retry);
    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    this.safetyGuardian = new SafetyGuardian(config.safety);
  }

  /**
   * Attempt recovery based on context
   */
  async attemptRecovery(context: RecoveryContext): Promise<RecoveryResult> {
    const classified = context.failure;
    let result: RecoveryResult;

    // Check safety first
    const safetyCheck = this.safetyGuardian.checkLimits({
      taskId: context.taskId,
      activeRetries: DEFAULT_RECOVERY_CONFIG.safety.maxConcurrentRetries,
    });

    if (!safetyCheck.passed) {
      result = {
        success: false,
        action: 'halt',
        message: `Safety violations: ${safetyCheck.violations.map((v) => v.description).join(', ')}`,
      };
    } else {
      // Determine recovery action based on failure category
      switch (classified.category) {
        case 'transient':
          result = await this.handleTransientFailure(context);
          break;
        case 'permanent':
          result = await this.handlePermanentFailure(context);
          break;
        case 'safety':
          result = {
            success: false,
            action: 'halt',
            message: `Safety violation: ${classified.reason}`,
          };
          break;
        default:
          // Unknown - try retry once, then escalate
          if (context.remainingRetries > 0) {
            result = await this.handleTransientFailure(context);
          } else {
            result = await this.handlePermanentFailure(context);
          }
      }
    }

    // Store in history
    this.recoveryHistory.set(context.taskId, result);

    // Execute hooks
    await this.executeHooks(context, result);

    return result;
  }

  /**
   * Handle transient failure with retry
   */
  private async handleTransientFailure(
    context: RecoveryContext
  ): Promise<RecoveryResult> {
    this.safetyGuardian.incrementTaskRetry(context.taskId);

    return {
      success: true,
      action: 'retry',
      newState: 'retrying',
      message: `Transient failure detected, will retry. Remaining: ${context.remainingRetries - 1}`,
    };
  }

  /**
   * Handle permanent failure with rollback or escalation
   */
  private async handlePermanentFailure(
    context: RecoveryContext
  ): Promise<RecoveryResult> {
    // If checkpoint available, rollback
    if (context.lastCheckpointId) {
      return {
        success: true,
        action: 'rollback',
        newState: 'rolling_back',
        rollbackCheckpointId: context.lastCheckpointId,
        message: `Permanent failure, rolling back to checkpoint ${context.lastCheckpointId}`,
      };
    }

    // Otherwise escalate to reasoner
    const escalation: EscalationInfo = {
      targetModel: 'deepseek-reasoner',
      reason: context.failure.reason,
      contextSummary: `Task ${context.taskId} failed with ${context.failure.category} error`,
      escalatedAt: Date.now(),
    };

    return {
      success: false,
      action: 'escalate',
      newState: 'escalated',
      escalation,
      message: `Escalating to ${escalation.targetModel}: ${escalation.reason}`,
    };
  }

  /**
   * Register recovery hook
   */
  registerHook(hook: RecoveryHook): void {
    this.hooks.push(hook);
  }

  /**
   * Execute registered hooks
   */
  private async executeHooks(
    context: RecoveryContext,
    result: RecoveryResult
  ): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook(context, result);
      } catch (error) {
        console.error('Recovery hook failed:', error);
      }
    }
  }

  /**
   * Get retry manager instance
   */
  getRetryManager(): RetryManager {
    return this.retryManager;
  }

  /**
   * Get circuit breaker instance
   */
  getCircuitBreaker(): CircuitBreaker {
    return this.circuitBreaker;
  }

  /**
   * Get safety guardian instance
   */
  getSafetyGuardian(): SafetyGuardian {
    return this.safetyGuardian;
  }

  /**
   * Get recovery history for task
   */
  getRecoveryHistory(taskId: string): RecoveryResult | undefined {
    return this.recoveryHistory.get(taskId);
  }
}

/** Singleton recovery engine instance */
export const recoveryEngine = new RecoveryEngine();

/** Factory for custom recovery engine instances */
export function createRecoveryEngine(
  config?: Partial<RecoveryConfig>
): RecoveryEngine {
  return new RecoveryEngine(config);
}

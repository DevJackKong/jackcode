/**
 * Thread 19: Recovery-Retry-Safety Types
 * Type definitions for resilience, retry logic, and safety guardrails
 */

/**
 * Failure classification categories
 */
export type FailureCategory = 'transient' | 'permanent' | 'safety' | 'unknown';

/**
 * Circuit breaker states
 */
export type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

/**
 * Recovery action levels
 */
export type RecoveryLevel = 'retry' | 'rollback' | 'escalate' | 'halt';

/**
 * Retry configuration
 */
export interface RetryConfig {
  /** Maximum retry attempts per operation */
  maxRetries: number;
  /** Initial delay between retries in ms */
  baseDelayMs: number;
  /** Maximum delay cap in ms */
  maxDelayMs: number;
  /** Exponential backoff multiplier */
  backoffMultiplier: number;
  /** Add random jitter to prevent thundering herd */
  jitter: boolean;
  /** Error types eligible for retry */
  retryableErrors: string[];
}

/**
 * Circuit breaker configuration
 */
export interface CircuitBreakerConfig {
  /** Failures before opening circuit */
  failureThreshold: number;
  /** Successes to close from half-open */
  successThreshold: number;
  /** Time before attempting half-open in ms */
  timeoutMs: number;
}

/**
 * Safety guardrail configuration
 */
export interface SafetyConfig {
  /** Global retry limit per task */
  maxRetriesPerTask: number;
  /** Concurrent retry limit */
  maxConcurrentRetries: number;
  /** Absolute deadline for task in ms */
  totalTimeoutMs: number;
  /** Memory consumption cap in MB */
  memoryLimitMb: number;
  /** Enable loop detection */
  enableLoopDetection: boolean;
}

/**
 * Combined recovery configuration
 */
export interface RecoveryConfig {
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
  safety: SafetyConfig;
}

/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
  jitter: true,
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'RATE_LIMITED'],
};

/**
 * Default circuit breaker configuration
 */
export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  successThreshold: 3,
  timeoutMs: 60000,
};

/**
 * Default safety configuration
 */
export const DEFAULT_SAFETY_CONFIG: SafetyConfig = {
  maxRetriesPerTask: 10,
  maxConcurrentRetries: 5,
  totalTimeoutMs: 300000,
  memoryLimitMb: 512,
  enableLoopDetection: true,
};

/**
 * Default combined configuration
 */
export const DEFAULT_RECOVERY_CONFIG: RecoveryConfig = {
  retry: DEFAULT_RETRY_CONFIG,
  circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
  safety: DEFAULT_SAFETY_CONFIG,
};

/**
 * Classified failure with metadata
 */
export interface ClassifiedFailure {
  /** Failure category */
  category: FailureCategory;
  /** Original error */
  error: unknown;
  /** Human-readable reason */
  reason: string;
  /** Timestamp */
  timestamp: number;
  /** Whether retry is recommended */
  retryable: boolean;
}

/**
 * Retry attempt record
 */
export interface RetryAttempt {
  /** Attempt number (1-indexed) */
  attemptNumber: number;
  /** Timestamp of attempt */
  timestamp: number;
  /** Error that caused retry (if any) */
  error?: unknown;
  /** Delay before this attempt in ms */
  delayMs: number;
}

/**
 * Retry operation result
 */
export interface RetryResult<T> {
  /** Whether operation succeeded */
  success: boolean;
  /** Result value (if success) */
  value?: T;
  /** Error (if failure) */
  error?: unknown;
  /** Number of attempts made */
  attempts: number;
  /** Total duration in ms */
  durationMs: number;
  /** Retry history */
  retryHistory: RetryAttempt[];
}

/**
 * Circuit breaker statistics
 */
export interface CircuitStats {
  /** Current state */
  state: CircuitState;
  /** Consecutive failures */
  consecutiveFailures: number;
  /** Consecutive successes */
  consecutiveSuccesses: number;
  /** Total successes */
  totalSuccesses: number;
  /** Total failures */
  totalFailures: number;
  /** Last failure timestamp */
  lastFailureTime?: number;
  /** Circuit opened at (if open) */
  openedAt?: number;
}

/**
 * Safety check result
 */
export interface SafetyCheck {
  /** Whether all checks passed */
  passed: boolean;
  /** Violated guardrails (if any) */
  violations: SafetyViolation[];
  /** Resource usage snapshot */
  resources: ResourceSnapshot;
}

/**
 * Safety violation details
 */
export interface SafetyViolation {
  /** Guardrail that was violated */
  guardrail: string;
  /** Current value */
  current: number;
  /** Limit value */
  limit: number;
  /** Severity */
  severity: 'warning' | 'critical';
  /** Description */
  description: string;
}

/**
 * Resource usage snapshot
 */
export interface ResourceSnapshot {
  /** Memory usage in MB */
  memoryMb: number;
  /** Active retry count */
  activeRetries: number;
  /** Total retries for current task */
  taskRetryCount: number;
  /** Elapsed time in ms */
  elapsedMs: number;
}

/**
 * Recovery context
 */
export interface RecoveryContext {
  /** Session identifier */
  sessionId: string;
  /** Task identifier */
  taskId: string;
  /** Current state */
  currentState: string;
  /** Last checkpoint ID (if available) */
  lastCheckpointId?: string;
  /** Failure that triggered recovery */
  failure: ClassifiedFailure;
  /** Attempt history */
  attemptHistory: RetryAttempt[];
  /** Remaining retry budget */
  remainingRetries: number;
}

/**
 * Recovery result
 */
export interface RecoveryResult {
  /** Whether recovery succeeded */
  success: boolean;
  /** Recovery action taken */
  action: RecoveryLevel;
  /** New state (if transitioned) */
  newState?: string;
  /** Rollback checkpoint ID (if rolled back) */
  rollbackCheckpointId?: string;
  /** Escalation info (if escalated) */
  escalation?: EscalationInfo;
  /** Human-readable message */
  message: string;
}

/**
 * Escalation information
 */
export interface EscalationInfo {
  /** Target model/reasoner */
  targetModel: string;
  /** Reason for escalation */
  reason: string;
  /** Context summary */
  contextSummary: string;
  /** Escalation timestamp */
  escalatedAt: number;
}

/**
 * Loop detection pattern
 */
export interface LoopPattern {
  /** Pattern signature */
  signature: string;
  /** Pattern occurrences */
  occurrences: number;
  /** First seen timestamp */
  firstSeen: number;
  /** Last seen timestamp */
  lastSeen: number;
}

/**
 * Operation function type for retry wrapper
 */
export type Operation<T> = () => Promise<T>;

/**
 * Error classifier function type
 */
export type ErrorClassifier = (error: unknown) => FailureCategory;

/**
 * Recovery hook function type
 */
export type RecoveryHook = (
  context: RecoveryContext,
  result: RecoveryResult
) => Promise<void>;

/**
 * Circuit breaker event payload
 */
export interface CircuitBreakerEvent {
  /** Previous state */
  from: CircuitState;
  /** New state */
  to: CircuitState;
  /** Timestamp */
  timestamp: number;
  /** Reason for transition */
  reason: string;
}

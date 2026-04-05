/**
 * Thread 19: Recovery-Retry-Safety Types
 * Type definitions for resilience, retry logic, and safety guardrails
 */
/**
 * Default retry configuration
 */
export const DEFAULT_RETRY_CONFIG = {
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
export const DEFAULT_CIRCUIT_BREAKER_CONFIG = {
    failureThreshold: 5,
    successThreshold: 3,
    timeoutMs: 60000,
};
/**
 * Default safety configuration
 */
export const DEFAULT_SAFETY_CONFIG = {
    maxRetriesPerTask: 10,
    maxConcurrentRetries: 5,
    totalTimeoutMs: 300000,
    memoryLimitMb: 512,
    enableLoopDetection: true,
};
/**
 * Default combined configuration
 */
export const DEFAULT_RECOVERY_CONFIG = {
    retry: DEFAULT_RETRY_CONFIG,
    circuitBreaker: DEFAULT_CIRCUIT_BREAKER_CONFIG,
    safety: DEFAULT_SAFETY_CONFIG,
};

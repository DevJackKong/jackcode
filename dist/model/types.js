/**
 * Thread 09: Qwen Executor Router Types
 * Primary executor model routing types
 */
/** Default configuration */
export const DEFAULT_ROUTER_CONFIG = {
    maxConcurrency: 3,
    maxBatchSize: 5,
    defaultTimeoutMs: 60000,
    criticalTimeoutMs: 180000,
    enableBatching: true,
};

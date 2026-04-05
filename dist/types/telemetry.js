/**
 * Thread 18: Trace Observability Types
 * Type definitions for distributed tracing, metrics, and structured logging
 */
// ============================================================================
// Trace Flags
// ============================================================================
export const TraceFlags = {
    NONE: 0x00,
    SAMPLED: 0x01,
};
// ============================================================================
// Default Configuration
// ============================================================================
export const DEFAULT_TELEMETRY_CONFIG = {
    enabled: true,
    sampleRate: 1.0,
    maxFinishedSpans: 1000,
    maxSpanEvents: 100,
    serviceName: 'jackcode',
    defaultAttributes: {},
    logger: console,
};

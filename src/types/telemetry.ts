/**
 * Thread 18: Trace Observability Types
 * Type definitions for distributed tracing, metrics, and structured logging
 */

// ============================================================================
// Attribute Types
// ============================================================================

export type TraceAttributeValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean>;

export type TraceAttributes = Record<string, TraceAttributeValue>;
export type MetricLabels = Record<string, string>;
export type LogAttributes = Record<string, unknown>;

// ============================================================================
// Span Types
// ============================================================================

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
  isRemote: boolean;
}

export interface SpanStatus {
  code: 'unset' | 'ok' | 'error';
  message?: string;
}

export interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: TraceAttributes;
}

export interface SpanLink {
  context: SpanContext;
  attributes?: TraceAttributes;
}

export interface SpanOptions {
  parent?: SpanContext | { context: SpanContext };
  kind?: SpanKind;
  attributes?: TraceAttributes;
  startTime?: number;
  root?: boolean;
}

export interface SpanRecord {
  context: SpanContext;
  name: string;
  kind: SpanKind;
  startTime: number;
  endTime?: number;
  durationMs?: number;
  attributes: TraceAttributes;
  events: SpanEvent[];
  status: SpanStatus;
}

// ============================================================================
// Metric Types
// ============================================================================

export interface MetricPoint {
  name: string;
  type: MetricType;
  value: number;
  labels?: MetricLabels;
  timestamp: number;
}

export interface MetricsSnapshot {
  counters: MetricPoint[];
  gauges: MetricPoint[];
  histograms: MetricPoint[];
}

// ============================================================================
// Export Types
// ============================================================================

export interface TraceExportResult {
  exported: number;
  dropped?: number;
  errors?: string[];
}

export interface TraceExporter {
  export(spans: SpanRecord[]): Promise<TraceExportResult>;
  shutdown?(): Promise<void>;
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface TelemetryConfig {
  enabled: boolean;
  sampleRate: number;
  maxFinishedSpans: number;
  maxSpanEvents: number;
  serviceName: string;
  defaultAttributes?: TraceAttributes;
  exporter?: TraceExporter;
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}

// ============================================================================
// Log Types
// ============================================================================

export interface LogRecord {
  level: LogLevel;
  message: string;
  timestamp: number;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  attributes?: LogAttributes;
  error?: unknown;
}

// ============================================================================
// Diagnostic Types
// ============================================================================

export interface TraceDiagnosticView {
  formatTrace(traceId: string, spans: SpanRecord[]): string;
  formatSpanTree(spans: SpanRecord[]): string;
  findSlowSpans(spans: SpanRecord[], thresholdMs: number): SpanRecord[];
}

// ============================================================================
// Trace Flags
// ============================================================================

export const TraceFlags = {
  NONE: 0x00,
  SAMPLED: 0x01,
} as const;

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  sampleRate: 1.0,
  maxFinishedSpans: 1000,
  maxSpanEvents: 100,
  serviceName: 'jackcode',
  defaultAttributes: {},
  logger: console,
};

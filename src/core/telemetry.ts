/**
 * Thread 18: Trace Observability
 * Lightweight tracing, metrics, and structured logging scaffolding for JackCode.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';

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

export interface SpanOptions {
  parent?: SpanContext | Span;
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

export interface TraceExportResult {
  exported: number;
  dropped?: number;
  errors?: string[];
}

export interface TraceExporter {
  export(spans: SpanRecord[]): Promise<TraceExportResult>;
  shutdown?(): Promise<void>;
}

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

export interface TraceDiagnosticView {
  formatTrace(traceId: string, spans: SpanRecord[]): string;
  formatSpanTree(spans: SpanRecord[]): string;
  findSlowSpans(spans: SpanRecord[], thresholdMs: number): SpanRecord[];
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  sampleRate: 1,
  maxFinishedSpans: 1000,
  maxSpanEvents: 100,
  serviceName: 'jackcode',
  defaultAttributes: {},
  logger: console,
};

export class DefaultTraceIdGenerator {
  generateTraceId(): string {
    return randomBytes(16).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }

  isValidTraceId(traceId: string): boolean {
    return /^[0-9a-f]{32}$/.test(traceId);
  }

  isValidSpanId(spanId: string): boolean {
    return /^[0-9a-f]{16}$/.test(spanId);
  }
}

export class Span {
  readonly context: SpanContext;
  readonly name: string;

  private readonly kind: SpanKind;
  private readonly startTime: number;
  private readonly maxEvents: number;
  private readonly attributes: TraceAttributes;
  private readonly events: SpanEvent[] = [];
  private status: SpanStatus = { code: 'unset' };
  private endTime?: number;

  constructor(
    name: string,
    context: SpanContext,
    options: {
      kind?: SpanKind;
      attributes?: TraceAttributes;
      startTime?: number;
      maxEvents?: number;
    } = {}
  ) {
    this.name = name;
    this.context = context;
    this.kind = options.kind || 'internal';
    this.startTime = options.startTime || Date.now();
    this.maxEvents = options.maxEvents || DEFAULT_TELEMETRY_CONFIG.maxSpanEvents;
    this.attributes = { ...(options.attributes || {}) };
  }

  setAttribute(key: string, value: TraceAttributeValue): void {
    this.attributes[key] = value;
  }

  setAttributes(attributes: TraceAttributes): void {
    Object.assign(this.attributes, attributes);
  }

  addEvent(name: string, attributes?: TraceAttributes): void {
    if (this.events.length >= this.maxEvents) {
      return;
    }

    this.events.push({
      name,
      timestamp: Date.now(),
      attributes,
    });
  }

  setStatus(status: SpanStatus): void {
    this.status = status;
  }

  recordException(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.setStatus({ code: 'error', message });
    this.addEvent('exception', {
      'error.message': message,
      'error.name': error instanceof Error ? error.name : 'Error',
    });
  }

  end(endTime = Date.now()): SpanRecord {
    if (this.endTime !== undefined) {
      return this.toRecord();
    }

    this.endTime = endTime;
    if (this.status.code === 'unset') {
      this.status = { code: 'ok' };
    }

    return this.toRecord();
  }

  toRecord(): SpanRecord {
    const endTime = this.endTime;

    return {
      context: { ...this.context },
      name: this.name,
      kind: this.kind,
      startTime: this.startTime,
      endTime,
      durationMs: endTime !== undefined ? endTime - this.startTime : undefined,
      attributes: { ...this.attributes },
      events: [...this.events],
      status: { ...this.status },
    };
  }
}

export class MetricsCollector {
  private counters: MetricPoint[] = [];
  private gauges: MetricPoint[] = [];
  private histograms: MetricPoint[] = [];

  incrementCounter(name: string, value = 1, labels?: MetricLabels): void {
    this.counters.push(this.createPoint(name, 'counter', value, labels));
  }

  recordGauge(name: string, value: number, labels?: MetricLabels): void {
    this.gauges.push(this.createPoint(name, 'gauge', value, labels));
  }

  recordHistogram(name: string, value: number, labels?: MetricLabels): void {
    this.histograms.push(this.createPoint(name, 'histogram', value, labels));
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.counters],
      gauges: [...this.gauges],
      histograms: [...this.histograms],
    };
  }

  reset(): void {
    this.counters = [];
    this.gauges = [];
    this.histograms = [];
  }

  private createPoint(
    name: string,
    type: MetricType,
    value: number,
    labels?: MetricLabels
  ): MetricPoint {
    return {
      name,
      type,
      value,
      labels,
      timestamp: Date.now(),
    };
  }
}

export class Tracer {
  private readonly config: TelemetryConfig;
  private readonly idGenerator: DefaultTraceIdGenerator;
  private readonly contextStorage = new AsyncLocalStorage<SpanContext>();
  private readonly finishedSpans: SpanRecord[] = [];
  private readonly activeSpans: Map<string, Span> = new Map();
  private readonly metricsCollector: MetricsCollector;

  constructor(
    config: Partial<TelemetryConfig> = {},
    idGenerator = new DefaultTraceIdGenerator(),
    metricsCollector = new MetricsCollector()
  ) {
    this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
    this.idGenerator = idGenerator;
    this.metricsCollector = metricsCollector;
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const parentContext = this.resolveParentContext(options.parent, options.root === true);
    const context: SpanContext = {
      traceId: parentContext?.traceId || this.idGenerator.generateTraceId(),
      spanId: this.idGenerator.generateSpanId(),
      parentSpanId: parentContext?.spanId,
      traceFlags: parentContext?.traceFlags ?? 1,
      isRemote: false,
    };

    const span = new Span(name, context, {
      kind: options.kind,
      startTime: options.startTime,
      attributes: {
        'service.name': this.config.serviceName,
        ...(this.config.defaultAttributes || {}),
        ...(options.attributes || {}),
      },
      maxEvents: this.config.maxSpanEvents,
    });

    this.activeSpans.set(context.spanId, span);
    this.metricsCollector.incrementCounter('jackcode.trace.started', 1, {
      span_name: name,
      service_name: this.config.serviceName,
    });

    return span;
  }

  startActiveSpan<T>(
    name: string,
    fn: (span: Span) => T,
    options: SpanOptions = {}
  ): T {
    const span = this.startSpan(name, options);

    return this.contextStorage.run(span.context, () => {
      try {
        const result = fn(span);
        return result;
      } catch (error) {
        span.recordException(error);
        throw error;
      } finally {
        this.finishSpan(span);
      }
    });
  }

  withContext<T>(context: SpanContext, fn: () => T): T {
    return this.contextStorage.run(context, fn);
  }

  getActiveContext(): SpanContext | undefined {
    return this.contextStorage.getStore();
  }

  getFinishedSpans(): SpanRecord[] {
    return [...this.finishedSpans];
  }

  getMetricsCollector(): MetricsCollector {
    return this.metricsCollector;
  }

  finishSpan(span: Span): SpanRecord {
    const record = span.end();
    this.activeSpans.delete(span.context.spanId);
    this.pushFinishedSpan(record);

    this.metricsCollector.incrementCounter('jackcode.trace.completed', 1, {
      span_name: record.name,
      status: record.status.code,
    });

    if (record.durationMs !== undefined) {
      this.metricsCollector.recordHistogram('jackcode.span.duration_ms', record.durationMs, {
        span_name: record.name,
      });
    }

    return record;
  }

  async flush(): Promise<void> {
    if (!this.config.exporter || this.finishedSpans.length === 0) {
      return;
    }

    try {
      await this.config.exporter.export(this.getFinishedSpans());
    } catch {
      // Telemetry failures must not break the main path.
    }
  }

  private resolveParentContext(
    parent?: SpanContext | Span,
    forceRoot = false
  ): SpanContext | undefined {
    if (forceRoot) {
      return undefined;
    }

    if (parent instanceof Span) {
      return parent.context;
    }

    if (parent) {
      return parent;
    }

    return this.contextStorage.getStore();
  }

  private pushFinishedSpan(record: SpanRecord): void {
    this.finishedSpans.push(record);

    if (this.finishedSpans.length > this.config.maxFinishedSpans) {
      this.finishedSpans.shift();
    }
  }
}

export class TraceLogger {
  private readonly tracer: Tracer;
  private readonly sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
  private readonly defaultAttributes: LogAttributes;

  constructor(
    tracer: Tracer,
    sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> = console,
    defaultAttributes: LogAttributes = {}
  ) {
    this.tracer = tracer;
    this.sink = sink;
    this.defaultAttributes = { ...defaultAttributes };
  }

  debug(message: string, attributes?: LogAttributes): void {
    this.log('debug', message, attributes);
  }

  info(message: string, attributes?: LogAttributes): void {
    this.log('info', message, attributes);
  }

  warn(message: string, attributes?: LogAttributes): void {
    this.log('warn', message, attributes);
  }

  error(message: string, error?: unknown, attributes?: LogAttributes): void {
    this.log('error', message, attributes, error);
  }

  child(defaultAttributes: LogAttributes): TraceLogger {
    return new TraceLogger(this.tracer, this.sink, {
      ...this.defaultAttributes,
      ...defaultAttributes,
    });
  }

  private log(
    level: LogLevel,
    message: string,
    attributes?: LogAttributes,
    error?: unknown
  ): void {
    const context = this.tracer.getActiveContext();
    const record: LogRecord = {
      level,
      message,
      timestamp: Date.now(),
      traceId: context?.traceId,
      spanId: context?.spanId,
      parentSpanId: context?.parentSpanId,
      attributes: {
        ...this.defaultAttributes,
        ...(attributes || {}),
      },
      error,
    };

    this.sink[level](record);
  }
}

export class ConsoleTraceExporter implements TraceExporter {
  async export(spans: SpanRecord[]): Promise<TraceExportResult> {
    for (const span of spans) {
      console.info('[trace.export]', span);
    }

    return { exported: spans.length, dropped: 0 };
  }
}

export class DefaultTraceDiagnosticView implements TraceDiagnosticView {
  formatTrace(traceId: string, spans: SpanRecord[]): string {
    const traceSpans = spans.filter((span) => span.context.traceId === traceId);
    return this.formatSpanTree(traceSpans);
  }

  formatSpanTree(spans: SpanRecord[]): string {
    const byParent = new Map<string | undefined, SpanRecord[]>();

    for (const span of spans) {
      const key = span.context.parentSpanId;
      const existing = byParent.get(key) || [];
      existing.push(span);
      byParent.set(key, existing);
    }

    const roots = byParent.get(undefined) || [];
    const lines: string[] = [];

    for (const root of roots) {
      this.writeSpanTree(lines, root, byParent, 0);
    }

    return lines.join('\n');
  }

  findSlowSpans(spans: SpanRecord[], thresholdMs: number): SpanRecord[] {
    return spans.filter((span) => (span.durationMs || 0) >= thresholdMs);
  }

  private writeSpanTree(
    lines: string[],
    span: SpanRecord,
    byParent: Map<string | undefined, SpanRecord[]>,
    depth: number
  ): void {
    const indent = '  '.repeat(depth);
    const duration = span.durationMs !== undefined ? ` (${span.durationMs}ms)` : '';
    lines.push(`${indent}- ${span.name}${duration} [${span.status.code}]`);

    const children = byParent.get(span.context.spanId) || [];
    for (const child of children) {
      this.writeSpanTree(lines, child, byParent, depth + 1);
    }
  }
}

export const telemetry = new Tracer();
export const telemetryMetrics = telemetry.getMetricsCollector();
export const telemetryLogger = new TraceLogger(telemetry);
export const telemetryDiagnostics = new DefaultTraceDiagnosticView();

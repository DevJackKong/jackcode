/**
 * Thread 18: Trace Observability
 * Enhanced lightweight tracing, metrics, structured logging, export, and
 * visualization scaffolding for JackCode.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';

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

export interface SpanLink {
  context: SpanContext;
  attributes?: TraceAttributes;
}

export interface SpanOptions {
  parent?: SpanContext | Span | { context: SpanContext };
  kind?: SpanKind;
  attributes?: TraceAttributes;
  startTime?: number;
  root?: boolean;
  links?: SpanLink[];
  forceSampled?: boolean;
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
  links?: SpanLink[];
  sampled?: boolean;
}

export interface MetricPoint {
  name: string;
  type: MetricType;
  value: number;
  labels?: MetricLabels;
  timestamp: number;
}

export interface MetricAggregate {
  name: string;
  type: MetricType;
  count: number;
  sum: number;
  min: number;
  max: number;
  avg: number;
  latest: number;
  labels?: MetricLabels;
}

export interface MetricsSnapshot {
  counters: MetricPoint[];
  gauges: MetricPoint[];
  histograms: MetricPoint[];
  aggregates: MetricAggregate[];
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
  batchSize: number;
  autoFlushOnBatch: boolean;
  logLevel: LogLevel;
  logFilter?: (record: LogRecord) => boolean;
  now?: () => number;
  random?: () => number;
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

export interface TraceViewerNode {
  traceId: string;
  rootSpans: Array<TraceTreeNode>;
  spanCount: number;
  totalDurationMs: number;
  errors: number;
}

export interface TraceTreeNode {
  span: SpanRecord;
  children: TraceTreeNode[];
}

export interface TraceDashboard {
  generatedAt: number;
  serviceName: string;
  spanCount: number;
  traceCount: number;
  errorCount: number;
  avgDurationMs: number;
  slowSpans: SpanRecord[];
  metrics: MetricsSnapshot;
}

export interface TraceAlert {
  level: 'info' | 'warn' | 'critical';
  code: string;
  message: string;
  traceId?: string;
  spanId?: string;
}

export interface TraceReport {
  generatedAt: number;
  serviceName: string;
  summary: {
    traces: number;
    spans: number;
    errors: number;
    slowSpans: number;
  };
  alerts: TraceAlert[];
  dashboard: TraceDashboard;
  tracePreview: string;
}

export const TraceFlags = {
  NONE: 0x00,
  SAMPLED: 0x01,
} as const;

const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  enabled: true,
  sampleRate: 1,
  maxFinishedSpans: 1000,
  maxSpanEvents: 100,
  serviceName: 'jackcode',
  defaultAttributes: {},
  logger: console,
  batchSize: 50,
  autoFlushOnBatch: true,
  logLevel: 'info',
  now: () => Date.now(),
  random: () => Math.random(),
};

export class DefaultTraceIdGenerator {
  generateTraceId(): string {
    return randomBytes(16).toString('hex');
  }

  generateSpanId(): string {
    return randomBytes(8).toString('hex');
  }

  isValidTraceId(traceId: string): boolean {
    return /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId);
  }

  isValidSpanId(spanId: string): boolean {
    return /^[0-9a-f]{16}$/.test(spanId) && !/^0+$/.test(spanId);
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return !!value && typeof (value as Promise<T>).then === 'function';
}

function normalizeLabels(labels?: MetricLabels): MetricLabels | undefined {
  if (!labels) {
    return undefined;
  }

  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

function metricKey(name: string, type: MetricType, labels?: MetricLabels): string {
  return JSON.stringify({ name, type, labels: normalizeLabels(labels) ?? null });
}

function coerceErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class Span {
  readonly context: SpanContext;
  readonly name: string;

  private readonly kind: SpanKind;
  private readonly startTime: number;
  private readonly maxEvents: number;
  private readonly attributes: TraceAttributes;
  private readonly events: SpanEvent[] = [];
  private readonly links: SpanLink[];
  private readonly sampled: boolean;
  private readonly now: () => number;
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
      links?: SpanLink[];
      sampled?: boolean;
      now?: () => number;
    } = {}
  ) {
    this.name = name;
    this.context = context;
    this.kind = options.kind || 'internal';
    this.startTime = options.startTime ?? (options.now ?? Date.now)();
    this.maxEvents = options.maxEvents || DEFAULT_TELEMETRY_CONFIG.maxSpanEvents;
    this.attributes = { ...(options.attributes || {}) };
    this.links = [...(options.links || [])];
    this.sampled = options.sampled ?? true;
    this.now = options.now ?? Date.now;
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
      timestamp: this.now(),
      attributes,
    });
  }

  setStatus(status: SpanStatus): void {
    this.status = status;
  }

  recordException(error: unknown): void {
    const message = coerceErrorMessage(error);
    this.setStatus({ code: 'error', message });
    this.addEvent('exception', {
      'error.message': message,
      'error.name': error instanceof Error ? error.name : 'Error',
    });
  }

  end(endTime = this.now()): SpanRecord {
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
      links: this.links.map((link) => ({ context: { ...link.context }, attributes: { ...(link.attributes || {}) } })),
      sampled: this.sampled,
    };
  }
}

export class MetricsCollector {
  private counters: MetricPoint[] = [];
  private gauges: MetricPoint[] = [];
  private histograms: MetricPoint[] = [];
  private aggregates: Map<string, MetricAggregate> = new Map();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  incrementCounter(name: string, value = 1, labels?: MetricLabels): void {
    this.pushPoint(this.counters, this.createPoint(name, 'counter', value, labels));
  }

  recordGauge(name: string, value: number, labels?: MetricLabels): void {
    this.pushPoint(this.gauges, this.createPoint(name, 'gauge', value, labels));
  }

  recordHistogram(name: string, value: number, labels?: MetricLabels): void {
    this.pushPoint(this.histograms, this.createPoint(name, 'histogram', value, labels));
  }

  snapshot(): MetricsSnapshot {
    return {
      counters: [...this.counters],
      gauges: [...this.gauges],
      histograms: [...this.histograms],
      aggregates: [...this.aggregates.values()].map((entry) => ({
        ...entry,
        labels: entry.labels ? { ...entry.labels } : undefined,
      })),
    };
  }

  reset(): void {
    this.counters = [];
    this.gauges = [];
    this.histograms = [];
    this.aggregates.clear();
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
      labels: normalizeLabels(labels),
      timestamp: this.now(),
    };
  }

  private pushPoint(bucket: MetricPoint[], point: MetricPoint): void {
    bucket.push(point);

    const key = metricKey(point.name, point.type, point.labels);
    const existing = this.aggregates.get(key);
    if (!existing) {
      this.aggregates.set(key, {
        name: point.name,
        type: point.type,
        count: 1,
        sum: point.value,
        min: point.value,
        max: point.value,
        avg: point.value,
        latest: point.value,
        labels: point.labels,
      });
      return;
    }

    existing.count += 1;
    existing.sum += point.value;
    existing.min = Math.min(existing.min, point.value);
    existing.max = Math.max(existing.max, point.value);
    existing.avg = existing.sum / existing.count;
    existing.latest = point.value;
  }
}

export class Tracer {
  private readonly config: TelemetryConfig;
  private readonly idGenerator: DefaultTraceIdGenerator;
  private readonly contextStorage = new AsyncLocalStorage<SpanContext>();
  private readonly finishedSpans: SpanRecord[] = [];
  private readonly activeSpans: Map<string, Span> = new Map();
  private readonly metricsCollector: MetricsCollector;
  private readonly logs: LogRecord[] = [];
  private pendingExportSpans: SpanRecord[] = [];

  constructor(
    config: Partial<TelemetryConfig> = {},
    idGenerator = new DefaultTraceIdGenerator(),
    metricsCollector?: MetricsCollector
  ) {
    this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
    this.idGenerator = idGenerator;
    this.metricsCollector = metricsCollector ?? new MetricsCollector(this.config.now);
  }

  startSpan(name: string, options: SpanOptions = {}): Span {
    const now = this.config.now ?? Date.now;
    const disabled = !this.config.enabled;
    const parentContext = this.resolveParentContext(options.parent, options.root === true);
    const sampled = !disabled && this.shouldSample(parentContext, options.forceSampled);
    const context: SpanContext = {
      traceId: parentContext?.traceId || this.idGenerator.generateTraceId(),
      spanId: this.idGenerator.generateSpanId(),
      parentSpanId: parentContext?.spanId,
      traceFlags: sampled ? TraceFlags.SAMPLED : TraceFlags.NONE,
      isRemote: false,
    };

    const span = new Span(name, context, {
      kind: options.kind,
      startTime: options.startTime,
      attributes: {
        'service.name': this.config.serviceName,
        'trace.sample_rate': this.config.sampleRate,
        'trace.sampled': sampled,
        ...(this.config.defaultAttributes || {}),
        ...(options.attributes || {}),
      },
      links: options.links,
      sampled,
      maxEvents: this.config.maxSpanEvents,
      now,
    });

    this.activeSpans.set(context.spanId, span);
    this.metricsCollector.incrementCounter('jackcode.trace.started', 1, {
      span_name: name,
      service_name: this.config.serviceName,
      sampled: String(sampled),
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
        if (isPromiseLike(result)) {
          return result
            .then((value) => {
              this.finishSpan(span);
              return value;
            })
            .catch((error) => {
              span.recordException(error);
              this.finishSpan(span);
              throw error;
            }) as T;
        }

        this.finishSpan(span);
        return result;
      } catch (error) {
        span.recordException(error);
        this.finishSpan(span);
        throw error;
      }
    });
  }

  withContext<T>(context: SpanContext, fn: () => T): T {
    return this.contextStorage.run(context, fn);
  }

  injectContext(headers: Record<string, string> = {}, context?: SpanContext): Record<string, string> {
    const active = context ?? this.getActiveContext();
    if (!active || !this.idGenerator.isValidTraceId(active.traceId) || !this.idGenerator.isValidSpanId(active.spanId)) {
      return { ...headers };
    }

    return {
      ...headers,
      traceparent: `00-${active.traceId}-${active.spanId}-${active.traceFlags.toString(16).padStart(2, '0')}`,
      'x-trace-id': active.traceId,
      'x-span-id': active.spanId,
      ...(active.parentSpanId ? { 'x-parent-span-id': active.parentSpanId } : {}),
    };
  }

  extractContext(source: Record<string, string | undefined>): SpanContext | undefined {
    const traceparent = source.traceparent ?? source.Traceparent;
    if (traceparent) {
      const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i.exec(traceparent.trim());
      if (match) {
        return {
          traceId: match[1].toLowerCase(),
          spanId: match[2].toLowerCase(),
          traceFlags: Number.parseInt(match[3], 16),
          isRemote: true,
        };
      }
    }

    const traceId = source['x-trace-id'];
    const spanId = source['x-span-id'];
    if (traceId && spanId && this.idGenerator.isValidTraceId(traceId) && this.idGenerator.isValidSpanId(spanId)) {
      return {
        traceId,
        spanId,
        parentSpanId: source['x-parent-span-id'],
        traceFlags: TraceFlags.SAMPLED,
        isRemote: true,
      };
    }

    return undefined;
  }

  getActiveContext(): SpanContext | undefined {
    return this.contextStorage.getStore();
  }

  getFinishedSpans(): SpanRecord[] {
    return [...this.finishedSpans];
  }

  getActiveSpans(): SpanRecord[] {
    return [...this.activeSpans.values()].map((span) => span.toRecord());
  }

  getMetricsCollector(): MetricsCollector {
    return this.metricsCollector;
  }

  getLogs(): LogRecord[] {
    return [...this.logs];
  }

  recordLog(record: LogRecord): void {
    this.logs.push(record);
    this.metricsCollector.incrementCounter('jackcode.logs.emitted', 1, {
      level: record.level,
      correlated: String(!!record.traceId),
    });
  }

  finishSpan(span: Span): SpanRecord {
    const record = span.end();
    this.activeSpans.delete(span.context.spanId);

    if (record.sampled !== false) {
      this.pushFinishedSpan(record);
      this.pendingExportSpans.push(record);
    }

    this.metricsCollector.incrementCounter('jackcode.trace.completed', 1, {
      span_name: record.name,
      status: record.status.code,
      sampled: String(record.sampled !== false),
    });

    if (record.durationMs !== undefined) {
      this.metricsCollector.recordHistogram('jackcode.span.duration_ms', record.durationMs, {
        span_name: record.name,
      });
    }

    if (record.status.code === 'error') {
      this.metricsCollector.incrementCounter('jackcode.task.errors', 1, {
        span_name: record.name,
      });
    }

    if (this.config.autoFlushOnBatch && this.pendingExportSpans.length >= this.config.batchSize) {
      void this.flush();
    }

    return record;
  }

  recordPerformanceMetric(name: string, value: number, labels?: MetricLabels): void {
    this.metricsCollector.recordHistogram(name, value, labels);
  }

  recordBusinessMetric(name: string, value = 1, labels?: MetricLabels): void {
    this.metricsCollector.incrementCounter(name, value, labels);
  }

  recordCustomMetric(name: string, type: MetricType, value: number, labels?: MetricLabels): void {
    if (type === 'counter') {
      this.metricsCollector.incrementCounter(name, value, labels);
      return;
    }
    if (type === 'gauge') {
      this.metricsCollector.recordGauge(name, value, labels);
      return;
    }
    this.metricsCollector.recordHistogram(name, value, labels);
  }

  async flush(): Promise<TraceExportResult> {
    const exporter = this.config.exporter;
    if (!exporter || this.pendingExportSpans.length === 0) {
      return { exported: 0, dropped: 0 };
    }

    const batch = [...this.pendingExportSpans];
    this.pendingExportSpans = [];

    try {
      const result = await exporter.export(batch);
      this.metricsCollector.incrementCounter('jackcode.trace.exported', result.exported, {
        exporter: exporter.constructor.name,
      });
      if ((result.errors?.length || 0) > 0) {
        this.metricsCollector.incrementCounter('jackcode.trace.export_errors', result.errors!.length, {
          exporter: exporter.constructor.name,
        });
      }
      return result;
    } catch (error) {
      this.pendingExportSpans = [...batch, ...this.pendingExportSpans];
      this.metricsCollector.incrementCounter('jackcode.trace.export_errors', 1, {
        exporter: exporter.constructor.name,
      });
      this.recordLog({
        level: 'warn',
        message: 'Telemetry export failed',
        timestamp: (this.config.now ?? Date.now)(),
        attributes: { exporter: exporter.constructor.name, reason: coerceErrorMessage(error) },
        traceId: batch[0]?.context.traceId,
        spanId: batch[0]?.context.spanId,
      });
      return { exported: 0, dropped: 0, errors: [coerceErrorMessage(error)] };
    }
  }

  async shutdown(): Promise<void> {
    await this.flush();
    await this.config.exporter?.shutdown?.();
  }

  private resolveParentContext(
    parent?: SpanContext | Span | { context: SpanContext },
    forceRoot = false
  ): SpanContext | undefined {
    if (forceRoot) {
      return undefined;
    }

    if (parent instanceof Span) {
      return parent.context;
    }

    if (parent && 'context' in parent) {
      return parent.context;
    }

    if (parent && this.idGenerator.isValidTraceId(parent.traceId) && this.idGenerator.isValidSpanId(parent.spanId)) {
      return parent;
    }

    return this.contextStorage.getStore();
  }

  private shouldSample(parentContext?: SpanContext, forceSampled?: boolean): boolean {
    if (forceSampled !== undefined) {
      return forceSampled;
    }
    if (parentContext) {
      return (parentContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
    }
    const rate = Math.min(1, Math.max(0, this.config.sampleRate));
    return rate >= 1 ? true : (this.config.random ?? Math.random)() < rate;
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
  private readonly minLevel: LogLevel;
  private readonly filter?: (record: LogRecord) => boolean;
  private readonly now: () => number;

  constructor(
    tracer: Tracer,
    sink: Pick<Console, 'debug' | 'info' | 'warn' | 'error'> = console,
    defaultAttributes: LogAttributes = {},
    options: {
      minLevel?: LogLevel;
      filter?: (record: LogRecord) => boolean;
      now?: () => number;
    } = {}
  ) {
    this.tracer = tracer;
    this.sink = sink;
    this.defaultAttributes = { ...defaultAttributes };
    this.minLevel = options.minLevel ?? 'info';
    this.filter = options.filter;
    this.now = options.now ?? Date.now;
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
    }, {
      minLevel: this.minLevel,
      filter: this.filter,
      now: this.now,
    });
  }

  private log(
    level: LogLevel,
    message: string,
    attributes?: LogAttributes,
    error?: unknown
  ): void {
    if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
      return;
    }

    const context = this.tracer.getActiveContext();
    const record: LogRecord = {
      level,
      message,
      timestamp: this.now(),
      traceId: context?.traceId,
      spanId: context?.spanId,
      parentSpanId: context?.parentSpanId,
      attributes: {
        ...this.defaultAttributes,
        ...(attributes || {}),
      },
      error,
    };

    if (this.filter && !this.filter(record)) {
      return;
    }

    this.tracer.recordLog(record);
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

export class InMemoryTraceExporter implements TraceExporter {
  readonly batches: SpanRecord[][] = [];

  async export(spans: SpanRecord[]): Promise<TraceExportResult> {
    this.batches.push(spans.map((span) => ({ ...span, context: { ...span.context }, attributes: { ...span.attributes } })));
    return { exported: spans.length, dropped: 0 };
  }

  getExportedSpans(): SpanRecord[] {
    return this.batches.flat();
  }
}

export class CompositeTraceExporter implements TraceExporter {
  private readonly exporters: TraceExporter[];

  constructor(exporters: TraceExporter[]) {
    this.exporters = exporters;
  }

  async export(spans: SpanRecord[]): Promise<TraceExportResult> {
    let exported = 0;
    let dropped = 0;
    const errors: string[] = [];

    for (const exporter of this.exporters) {
      try {
        const result = await exporter.export(spans);
        exported = Math.max(exported, result.exported);
        dropped += result.dropped || 0;
        if (result.errors) {
          errors.push(...result.errors);
        }
      } catch (error) {
        errors.push(coerceErrorMessage(error));
      }
    }

    return { exported, dropped, errors };
  }

  async shutdown(): Promise<void> {
    for (const exporter of this.exporters) {
      await exporter.shutdown?.();
    }
  }
}

export class BatchTraceExporter implements TraceExporter {
  private readonly delegate: TraceExporter;
  private readonly batchSize: number;

  constructor(delegate: TraceExporter, batchSize = 50) {
    this.delegate = delegate;
    this.batchSize = batchSize;
  }

  async export(spans: SpanRecord[]): Promise<TraceExportResult> {
    let exported = 0;
    let dropped = 0;
    const errors: string[] = [];

    for (let index = 0; index < spans.length; index += this.batchSize) {
      const batch = spans.slice(index, index + this.batchSize);
      const result = await this.delegate.export(batch);
      exported += result.exported;
      dropped += result.dropped || 0;
      if (result.errors) {
        errors.push(...result.errors);
      }
    }

    return { exported, dropped, errors };
  }

  async shutdown(): Promise<void> {
    await this.delegate.shutdown?.();
  }
}

export class OtlpTraceExporter implements TraceExporter {
  readonly payloads: Array<Record<string, unknown>> = [];

  async export(spans: SpanRecord[]): Promise<TraceExportResult> {
    const payload = {
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: 'jackcode.telemetry' },
              spans: spans.map((span) => ({
                traceId: span.context.traceId,
                spanId: span.context.spanId,
                parentSpanId: span.context.parentSpanId,
                name: span.name,
                kind: span.kind,
                startTimeUnixMs: span.startTime,
                endTimeUnixMs: span.endTime,
                attributes: Object.entries(span.attributes).map(([key, value]) => ({ key, value })),
                status: span.status,
              })),
            },
          ],
        },
      ],
    };

    this.payloads.push(payload);
    return { exported: spans.length, dropped: 0 };
  }
}

export class JaegerTraceExporter implements TraceExporter {
  readonly payloads: Array<Record<string, unknown>> = [];

  async export(spans: SpanRecord[]): Promise<TraceExportResult> {
    const payload = {
      data: spans.map((span) => ({
        traceID: span.context.traceId,
        spanID: span.context.spanId,
        operationName: span.name,
        startTime: span.startTime * 1000,
        duration: (span.durationMs ?? 0) * 1000,
        references: span.context.parentSpanId
          ? [{ refType: 'CHILD_OF', spanID: span.context.parentSpanId, traceID: span.context.traceId }]
          : [],
        tags: Object.entries(span.attributes).map(([key, value]) => ({ key, value })),
      })),
    };

    this.payloads.push(payload);
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
      existing.sort((a, b) => a.startTime - b.startTime);
      byParent.set(key, existing);
    }

    const roots = (byParent.get(undefined) || []).sort((a, b) => a.startTime - b.startTime);
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

export class TraceVisualizer {
  buildViewer(spans: SpanRecord[]): TraceViewerNode[] {
    const byTrace = new Map<string, SpanRecord[]>();
    for (const span of spans) {
      const existing = byTrace.get(span.context.traceId) || [];
      existing.push(span);
      byTrace.set(span.context.traceId, existing);
    }

    return [...byTrace.entries()].map(([traceId, traceSpans]) => {
      const rootSpans = this.buildTree(traceSpans);
      return {
        traceId,
        rootSpans,
        spanCount: traceSpans.length,
        totalDurationMs: traceSpans.reduce((sum, span) => sum + (span.durationMs || 0), 0),
        errors: traceSpans.filter((span) => span.status.code === 'error').length,
      };
    });
  }

  buildDashboard(spans: SpanRecord[], metrics: MetricsSnapshot, serviceName = 'jackcode'): TraceDashboard {
    const traceIds = new Set(spans.map((span) => span.context.traceId));
    const errorCount = spans.filter((span) => span.status.code === 'error').length;
    const durations = spans.map((span) => span.durationMs || 0);
    const avgDurationMs = durations.length === 0 ? 0 : durations.reduce((sum, value) => sum + value, 0) / durations.length;

    return {
      generatedAt: Date.now(),
      serviceName,
      spanCount: spans.length,
      traceCount: traceIds.size,
      errorCount,
      avgDurationMs,
      slowSpans: spans
        .filter((span) => (span.durationMs || 0) >= Math.max(250, avgDurationMs * 0.9))
        .sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)),
      metrics,
    };
  }

  buildAlerts(spans: SpanRecord[], thresholdMs = 1000): TraceAlert[] {
    const alerts: TraceAlert[] = [];
    for (const span of spans) {
      if (span.status.code === 'error') {
        alerts.push({
          level: 'critical',
          code: 'trace.error',
          message: `Span ${span.name} failed${span.status.message ? `: ${span.status.message}` : ''}`,
          traceId: span.context.traceId,
          spanId: span.context.spanId,
        });
      }
      if ((span.durationMs || 0) >= thresholdMs) {
        alerts.push({
          level: 'warn',
          code: 'trace.slow_span',
          message: `Span ${span.name} exceeded ${thresholdMs}ms`,
          traceId: span.context.traceId,
          spanId: span.context.spanId,
        });
      }
    }
    return alerts;
  }

  generateReport(
    spans: SpanRecord[],
    metrics: MetricsSnapshot,
    serviceName = 'jackcode',
    thresholdMs = 1000
  ): TraceReport {
    const dashboard = this.buildDashboard(spans, metrics, serviceName);
    const alerts = this.buildAlerts(spans, thresholdMs);
    const diagnostics = new DefaultTraceDiagnosticView();
    const viewer = this.buildViewer(spans);

    return {
      generatedAt: Date.now(),
      serviceName,
      summary: {
        traces: dashboard.traceCount,
        spans: dashboard.spanCount,
        errors: dashboard.errorCount,
        slowSpans: alerts.filter((alert) => alert.code === 'trace.slow_span').length,
      },
      alerts,
      dashboard,
      tracePreview: viewer[0] ? diagnostics.formatTrace(viewer[0].traceId, spans) : '',
    };
  }

  renderTraceViewerHtml(spans: SpanRecord[]): string {
    const viewer = this.buildViewer(spans);
    const data = JSON.stringify(viewer, null, 2);
    return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>JackCode Trace Viewer</title></head>
<body>
  <h1>JackCode Trace Viewer</h1>
  <pre id="data"></pre>
  <script>
    const traces = ${data};
    document.getElementById('data').textContent = JSON.stringify(traces, null, 2);
  </script>
</body>
</html>`;
  }

  private buildTree(spans: SpanRecord[]): TraceTreeNode[] {
    const byParent = new Map<string | undefined, TraceTreeNode[]>();
    const nodes = spans.map((span) => ({ span, children: [] as TraceTreeNode[] }));

    for (const node of nodes) {
      const key = node.span.context.parentSpanId;
      const existing = byParent.get(key) || [];
      existing.push(node);
      byParent.set(key, existing);
    }

    for (const node of nodes) {
      node.children = (byParent.get(node.span.context.spanId) || []).sort(
        (a, b) => a.span.startTime - b.span.startTime
      );
    }

    return (byParent.get(undefined) || []).sort((a, b) => a.span.startTime - b.span.startTime);
  }
}

export const telemetry = new Tracer();
export const telemetryMetrics = telemetry.getMetricsCollector();
export const telemetryLogger = new TraceLogger(telemetry, DEFAULT_TELEMETRY_CONFIG.logger ?? console, {}, {
  minLevel: DEFAULT_TELEMETRY_CONFIG.logLevel,
  filter: DEFAULT_TELEMETRY_CONFIG.logFilter,
  now: DEFAULT_TELEMETRY_CONFIG.now,
});
export const telemetryDiagnostics = new DefaultTraceDiagnosticView();
export const telemetryVisualizer = new TraceVisualizer();

/**
 * Thread 18: Trace Observability
 * Enhanced lightweight tracing, metrics, structured logging, export, and
 * visualization scaffolding for JackCode.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
export const TraceFlags = {
    NONE: 0x00,
    SAMPLED: 0x01,
};
const LOG_LEVEL_ORDER = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};
export const DEFAULT_TELEMETRY_CONFIG = {
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
    generateTraceId() {
        return randomBytes(16).toString('hex');
    }
    generateSpanId() {
        return randomBytes(8).toString('hex');
    }
    isValidTraceId(traceId) {
        return /^[0-9a-f]{32}$/.test(traceId) && !/^0+$/.test(traceId);
    }
    isValidSpanId(spanId) {
        return /^[0-9a-f]{16}$/.test(spanId) && !/^0+$/.test(spanId);
    }
}
function isPromiseLike(value) {
    return !!value && typeof value.then === 'function';
}
function normalizeLabels(labels) {
    if (!labels) {
        return undefined;
    }
    const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
}
function metricKey(name, type, labels) {
    return JSON.stringify({ name, type, labels: normalizeLabels(labels) ?? null });
}
function coerceErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
export class Span {
    context;
    name;
    kind;
    startTime;
    maxEvents;
    attributes;
    events = [];
    links;
    sampled;
    now;
    status = { code: 'unset' };
    endTime;
    constructor(name, context, options = {}) {
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
    setAttribute(key, value) {
        this.attributes[key] = value;
    }
    setAttributes(attributes) {
        Object.assign(this.attributes, attributes);
    }
    addEvent(name, attributes) {
        if (this.events.length >= this.maxEvents) {
            return;
        }
        this.events.push({
            name,
            timestamp: this.now(),
            attributes,
        });
    }
    setStatus(status) {
        this.status = status;
    }
    recordException(error) {
        const message = coerceErrorMessage(error);
        this.setStatus({ code: 'error', message });
        this.addEvent('exception', {
            'error.message': message,
            'error.name': error instanceof Error ? error.name : 'Error',
        });
    }
    end(endTime = this.now()) {
        if (this.endTime !== undefined) {
            return this.toRecord();
        }
        this.endTime = endTime;
        if (this.status.code === 'unset') {
            this.status = { code: 'ok' };
        }
        return this.toRecord();
    }
    toRecord() {
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
    counters = [];
    gauges = [];
    histograms = [];
    aggregates = new Map();
    now;
    constructor(now = () => Date.now()) {
        this.now = now;
    }
    incrementCounter(name, value = 1, labels) {
        this.pushPoint(this.counters, this.createPoint(name, 'counter', value, labels));
    }
    recordGauge(name, value, labels) {
        this.pushPoint(this.gauges, this.createPoint(name, 'gauge', value, labels));
    }
    recordHistogram(name, value, labels) {
        this.pushPoint(this.histograms, this.createPoint(name, 'histogram', value, labels));
    }
    snapshot() {
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
    reset() {
        this.counters = [];
        this.gauges = [];
        this.histograms = [];
        this.aggregates.clear();
    }
    createPoint(name, type, value, labels) {
        return {
            name,
            type,
            value,
            labels: normalizeLabels(labels),
            timestamp: this.now(),
        };
    }
    pushPoint(bucket, point) {
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
    config;
    idGenerator;
    contextStorage = new AsyncLocalStorage();
    finishedSpans = [];
    activeSpans = new Map();
    metricsCollector;
    logs = [];
    pendingExportSpans = [];
    constructor(config = {}, idGenerator = new DefaultTraceIdGenerator(), metricsCollector) {
        this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
        this.idGenerator = idGenerator;
        this.metricsCollector = metricsCollector ?? new MetricsCollector(this.config.now);
    }
    startSpan(name, options = {}) {
        const now = this.config.now ?? Date.now;
        const disabled = !this.config.enabled;
        const parentContext = this.resolveParentContext(options.parent, options.root === true);
        const sampled = !disabled && this.shouldSample(parentContext, options.forceSampled);
        const context = {
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
    startActiveSpan(name, fn, options = {}) {
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
                    });
                }
                this.finishSpan(span);
                return result;
            }
            catch (error) {
                span.recordException(error);
                this.finishSpan(span);
                throw error;
            }
        });
    }
    withContext(context, fn) {
        return this.contextStorage.run(context, fn);
    }
    injectContext(headers = {}, context) {
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
    extractContext(source) {
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
    getActiveContext() {
        return this.contextStorage.getStore();
    }
    getFinishedSpans() {
        return [...this.finishedSpans];
    }
    getActiveSpans() {
        return [...this.activeSpans.values()].map((span) => span.toRecord());
    }
    getMetricsCollector() {
        return this.metricsCollector;
    }
    getLogs() {
        return [...this.logs];
    }
    recordLog(record) {
        this.logs.push(record);
        this.metricsCollector.incrementCounter('jackcode.logs.emitted', 1, {
            level: record.level,
            correlated: String(!!record.traceId),
        });
    }
    finishSpan(span) {
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
    recordPerformanceMetric(name, value, labels) {
        this.metricsCollector.recordHistogram(name, value, labels);
    }
    recordBusinessMetric(name, value = 1, labels) {
        this.metricsCollector.incrementCounter(name, value, labels);
    }
    recordCustomMetric(name, type, value, labels) {
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
    async flush() {
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
                this.metricsCollector.incrementCounter('jackcode.trace.export_errors', result.errors.length, {
                    exporter: exporter.constructor.name,
                });
            }
            return result;
        }
        catch (error) {
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
    async shutdown() {
        await this.flush();
        await this.config.exporter?.shutdown?.();
    }
    resolveParentContext(parent, forceRoot = false) {
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
    shouldSample(parentContext, forceSampled) {
        if (forceSampled !== undefined) {
            return forceSampled;
        }
        if (parentContext) {
            return (parentContext.traceFlags & TraceFlags.SAMPLED) === TraceFlags.SAMPLED;
        }
        const rate = Math.min(1, Math.max(0, this.config.sampleRate));
        return rate >= 1 ? true : (this.config.random ?? Math.random)() < rate;
    }
    pushFinishedSpan(record) {
        this.finishedSpans.push(record);
        if (this.finishedSpans.length > this.config.maxFinishedSpans) {
            this.finishedSpans.shift();
        }
    }
}
export class TraceLogger {
    tracer;
    sink;
    defaultAttributes;
    minLevel;
    filter;
    now;
    constructor(tracer, sink = console, defaultAttributes = {}, options = {}) {
        this.tracer = tracer;
        this.sink = sink;
        this.defaultAttributes = { ...defaultAttributes };
        this.minLevel = options.minLevel ?? 'info';
        this.filter = options.filter;
        this.now = options.now ?? Date.now;
    }
    debug(message, attributes) {
        this.log('debug', message, attributes);
    }
    info(message, attributes) {
        this.log('info', message, attributes);
    }
    warn(message, attributes) {
        this.log('warn', message, attributes);
    }
    error(message, error, attributes) {
        this.log('error', message, attributes, error);
    }
    child(defaultAttributes) {
        return new TraceLogger(this.tracer, this.sink, {
            ...this.defaultAttributes,
            ...defaultAttributes,
        }, {
            minLevel: this.minLevel,
            filter: this.filter,
            now: this.now,
        });
    }
    log(level, message, attributes, error) {
        if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) {
            return;
        }
        const context = this.tracer.getActiveContext();
        const record = {
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
export class ConsoleTraceExporter {
    async export(spans) {
        for (const span of spans) {
            console.info('[trace.export]', span);
        }
        return { exported: spans.length, dropped: 0 };
    }
}
export class InMemoryTraceExporter {
    batches = [];
    async export(spans) {
        this.batches.push(spans.map((span) => ({ ...span, context: { ...span.context }, attributes: { ...span.attributes } })));
        return { exported: spans.length, dropped: 0 };
    }
    getExportedSpans() {
        return this.batches.flat();
    }
}
export class CompositeTraceExporter {
    exporters;
    constructor(exporters) {
        this.exporters = exporters;
    }
    async export(spans) {
        let exported = 0;
        let dropped = 0;
        const errors = [];
        for (const exporter of this.exporters) {
            try {
                const result = await exporter.export(spans);
                exported = Math.max(exported, result.exported);
                dropped += result.dropped || 0;
                if (result.errors) {
                    errors.push(...result.errors);
                }
            }
            catch (error) {
                errors.push(coerceErrorMessage(error));
            }
        }
        return { exported, dropped, errors };
    }
    async shutdown() {
        for (const exporter of this.exporters) {
            await exporter.shutdown?.();
        }
    }
}
export class BatchTraceExporter {
    delegate;
    batchSize;
    constructor(delegate, batchSize = 50) {
        this.delegate = delegate;
        this.batchSize = batchSize;
    }
    async export(spans) {
        let exported = 0;
        let dropped = 0;
        const errors = [];
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
    async shutdown() {
        await this.delegate.shutdown?.();
    }
}
export class OtlpTraceExporter {
    payloads = [];
    async export(spans) {
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
export class JaegerTraceExporter {
    payloads = [];
    async export(spans) {
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
export class DefaultTraceDiagnosticView {
    formatTrace(traceId, spans) {
        const traceSpans = spans.filter((span) => span.context.traceId === traceId);
        return this.formatSpanTree(traceSpans);
    }
    formatSpanTree(spans) {
        const byParent = new Map();
        for (const span of spans) {
            const key = span.context.parentSpanId;
            const existing = byParent.get(key) || [];
            existing.push(span);
            existing.sort((a, b) => a.startTime - b.startTime);
            byParent.set(key, existing);
        }
        const roots = (byParent.get(undefined) || []).sort((a, b) => a.startTime - b.startTime);
        const lines = [];
        for (const root of roots) {
            this.writeSpanTree(lines, root, byParent, 0);
        }
        return lines.join('\n');
    }
    findSlowSpans(spans, thresholdMs) {
        return spans.filter((span) => (span.durationMs || 0) >= thresholdMs);
    }
    writeSpanTree(lines, span, byParent, depth) {
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
    buildViewer(spans) {
        const byTrace = new Map();
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
    buildDashboard(spans, metrics, serviceName = 'jackcode') {
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
    buildAlerts(spans, thresholdMs = 1000) {
        const alerts = [];
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
    generateReport(spans, metrics, serviceName = 'jackcode', thresholdMs = 1000) {
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
    renderTraceViewerHtml(spans) {
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
    buildTree(spans) {
        const byParent = new Map();
        const nodes = spans.map((span) => ({ span, children: [] }));
        for (const node of nodes) {
            const key = node.span.context.parentSpanId;
            const existing = byParent.get(key) || [];
            existing.push(node);
            byParent.set(key, existing);
        }
        for (const node of nodes) {
            node.children = (byParent.get(node.span.context.spanId) || []).sort((a, b) => a.span.startTime - b.span.startTime);
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

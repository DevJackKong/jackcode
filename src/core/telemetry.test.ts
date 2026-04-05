import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BatchTraceExporter,
  CompositeTraceExporter,
  InMemoryTraceExporter,
  JaegerTraceExporter,
  MetricsCollector,
  OtlpTraceExporter,
  TraceLogger,
  TraceVisualizer,
  Tracer,
  type LogRecord,
} from './telemetry.js';

function createClock(start = 1000) {
  let current = start;
  return {
    now: () => current,
    tick: (delta = 1) => {
      current += delta;
      return current;
    },
  };
}

test('propagates distributed trace context across module boundaries', () => {
  const clock = createClock();
  const tracer = new Tracer({ now: clock.now, random: () => 0, sampleRate: 1 });

  const root = tracer.startSpan('session.create');
  const headers = tracer.injectContext({}, root.context);
  assert.match(headers.traceparent ?? '', /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);

  const remoteParent = tracer.extractContext(headers);
  assert.ok(remoteParent);
  assert.equal(remoteParent?.traceId, root.context.traceId);
  assert.equal(remoteParent?.spanId, root.context.spanId);
  assert.equal(remoteParent?.isRemote, true);

  const child = tracer.startSpan('model.qwen.route', { parent: remoteParent! });
  assert.equal(child.context.traceId, root.context.traceId);
  assert.equal(child.context.parentSpanId, root.context.spanId);
});

test('supports async active spans and correlation attributes', async () => {
  const clock = createClock();
  const exporter = new InMemoryTraceExporter();
  const tracer = new Tracer({ now: clock.now, random: () => 0, sampleRate: 1, exporter });

  await tracer.startActiveSpan('task.execute', async (span) => {
    span.setAttributes({
      'correlation.task_id': 'task-42',
      'correlation.session_id': 'session-7',
      'module.name': 'executor',
    });
    clock.tick(15);
    await Promise.resolve();
    clock.tick(10);
  });

  const [record] = tracer.getFinishedSpans();
  assert.equal(record.attributes['correlation.task_id'], 'task-42');
  assert.equal(record.attributes['correlation.session_id'], 'session-7');
  assert.equal(record.attributes['module.name'], 'executor');
  assert.equal(record.durationMs, 25);

  const flush = await tracer.flush();
  assert.equal(flush.exported, 1);
  assert.equal(exporter.getExportedSpans().length, 1);
});

test('applies trace sampling to root spans and inherits flags for children', () => {
  const clock = createClock();
  const tracer = new Tracer({ now: clock.now, sampleRate: 0, random: () => 0.99 });

  const unsampledRoot = tracer.startSpan('unsampled.root');
  tracer.finishSpan(unsampledRoot);

  assert.equal(tracer.getFinishedSpans().length, 0);
  assert.equal(unsampledRoot.toRecord().sampled, false);
  assert.equal(unsampledRoot.context.traceFlags, 0);

  const forcedParent = tracer.startSpan('forced.root', { forceSampled: true });
  const child = tracer.startSpan('forced.child', { parent: forcedParent });
  tracer.finishSpan(forcedParent);
  tracer.finishSpan(child);

  const records = tracer.getFinishedSpans();
  assert.equal(records.length, 2);
  assert.equal(records[0].sampled, true);
  assert.equal(records[1].context.traceFlags, 1);
});

test('aggregates performance, business, and custom metrics', () => {
  const clock = createClock();
  const metrics = new MetricsCollector(clock.now);

  metrics.incrementCounter('jackcode.model.request_count', 1, { model: 'qwen' });
  metrics.incrementCounter('jackcode.model.request_count', 2, { model: 'qwen' });
  metrics.recordHistogram('jackcode.model.latency_ms', 120, { model: 'qwen' });
  metrics.recordHistogram('jackcode.model.latency_ms', 80, { model: 'qwen' });
  metrics.recordGauge('jackcode.pool.load', 0.75, { model: 'qwen' });

  const snapshot = metrics.snapshot();
  assert.equal(snapshot.counters.length, 2);
  assert.equal(snapshot.histograms.length, 2);
  assert.equal(snapshot.gauges.length, 1);

  const counterAggregate = snapshot.aggregates.find((entry) => entry.name === 'jackcode.model.request_count');
  assert.ok(counterAggregate);
  assert.equal(counterAggregate?.count, 2);
  assert.equal(counterAggregate?.sum, 3);
  assert.equal(counterAggregate?.avg, 1.5);

  const latencyAggregate = snapshot.aggregates.find((entry) => entry.name === 'jackcode.model.latency_ms');
  assert.ok(latencyAggregate);
  assert.equal(latencyAggregate?.min, 80);
  assert.equal(latencyAggregate?.max, 120);
  assert.equal(latencyAggregate?.avg, 100);
});

test('emits structured logs with trace correlation, level filtering, and custom filtering', () => {
  const clock = createClock();
  const tracer = new Tracer({ now: clock.now, random: () => 0, sampleRate: 1 });
  const sink: LogRecord[] = [];
  const logger = new TraceLogger(
    tracer,
    {
      debug: (record) => sink.push(record as LogRecord),
      info: (record) => sink.push(record as LogRecord),
      warn: (record) => sink.push(record as LogRecord),
      error: (record) => sink.push(record as LogRecord),
    },
    { service: 'jackcode' },
    {
      minLevel: 'info',
      filter: (record) => record.attributes?.['skip'] !== true,
      now: clock.now,
    }
  );

  tracer.startActiveSpan('review', () => {
    logger.debug('skip me');
    logger.info('visible', { module: 'reviewer' });
    logger.warn('drop me', { skip: true });
    logger.error('boom', new Error('bad'), { phase: 'verify' });
  });

  assert.equal(sink.length, 2);
  assert.equal(sink[0].level, 'info');
  assert.equal(sink[1].level, 'error');
  assert.equal(sink[0].traceId, sink[1].traceId);
  assert.equal(sink[0].attributes?.['service'], 'jackcode');
  assert.equal(sink[0].attributes?.['module'], 'reviewer');
  assert.equal(tracer.getLogs().length, 2);
});

test('supports batch, OTLP, Jaeger, and composite exporters', async () => {
  const clock = createClock();
  const otlp = new OtlpTraceExporter();
  const jaeger = new JaegerTraceExporter();
  const composite = new CompositeTraceExporter([otlp, jaeger]);
  const batch = new BatchTraceExporter(composite, 2);
  const tracer = new Tracer({ now: clock.now, random: () => 0, sampleRate: 1, exporter: batch });

  for (let index = 0; index < 5; index += 1) {
    const span = tracer.startSpan(`span-${index}`);
    clock.tick(5);
    tracer.finishSpan(span);
  }

  const result = await tracer.flush();
  assert.equal(result.exported, 5);
  assert.equal(otlp.payloads.length, 3);
  assert.equal(jaeger.payloads.length, 3);

  const otlpSpanCount = otlp.payloads
    .flatMap((payload) => (payload.resourceSpans as Array<Record<string, unknown>>))
    .flatMap((resource) => (resource.scopeSpans as Array<Record<string, unknown>>))
    .flatMap((scope) => (scope.spans as Array<Record<string, unknown>>)).length;
  assert.equal(otlpSpanCount, 5);
});

test('generates trace viewer, dashboard, alerts, and report output', () => {
  const clock = createClock();
  const tracer = new Tracer({ now: clock.now, random: () => 0, sampleRate: 1 });

  const root = tracer.startSpan('session.create', { attributes: { sessionId: 's-1' } });
  clock.tick(50);
  const child = tracer.startSpan('test.run', { parent: root });
  child.recordException(new Error('failed test'));
  clock.tick(1100);
  tracer.finishSpan(child);
  tracer.finishSpan(root);

  const visualizer = new TraceVisualizer();
  const spans = tracer.getFinishedSpans();
  const metrics = tracer.getMetricsCollector().snapshot();

  const viewer = visualizer.buildViewer(spans);
  assert.equal(viewer.length, 1);
  assert.equal(viewer[0].rootSpans.length, 1);
  assert.equal(viewer[0].rootSpans[0].children.length, 1);

  const dashboard = visualizer.buildDashboard(spans, metrics, 'jackcode');
  assert.equal(dashboard.traceCount, 1);
  assert.equal(dashboard.errorCount, 1);
  assert.ok(dashboard.slowSpans.some((span) => span.name === 'test.run'));

  const alerts = visualizer.buildAlerts(spans, 1000);
  assert.ok(alerts.some((alert) => alert.code === 'trace.error'));
  assert.ok(alerts.some((alert) => alert.code === 'trace.slow_span'));

  const report = visualizer.generateReport(spans, metrics, 'jackcode', 1000);
  assert.equal(report.summary.traces, 1);
  assert.ok(report.tracePreview.includes('session.create'));

  const html = visualizer.renderTraceViewerHtml(spans);
  assert.ok(html.includes('JackCode Trace Viewer'));
  assert.ok(html.includes(root.context.traceId));
});

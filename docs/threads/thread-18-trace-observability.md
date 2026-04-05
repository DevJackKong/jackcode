# Thread 18: Trace Observability

## Purpose
Provide distributed tracing and observability for JackCode agent operations. The module gives operators and developers a consistent way to understand what happened during a task, how long each step took, where failures occurred, and how execution flowed across runtime, session, model, patch, and QA boundaries.

## Responsibilities
1. **Span creation and lifecycle management** for core operations
2. **Trace context propagation** across async execution and module boundaries
3. **Trace ID generation and correlation** for logs, metrics, and downstream systems
4. **Performance metrics collection** for latency, throughput, counts, and error rates
5. **Structured logging with trace context** so logs can be joined back to spans
6. **Optional export interface** for external observability backends
7. **Debug and diagnostic views** for local troubleshooting without external tooling

## Design Goals
- Keep the first implementation lightweight and dependency-free
- Match the project’s scaffold-first style used by other threads
- Work standalone inside JackCode, but stay compatible with future OpenTelemetry-style adapters
- Avoid making telemetry mandatory for every module
- Make observability data useful in both local CLI workflows and JackClaw-integrated environments

## Non-Goals
- Full OpenTelemetry implementation in this thread
- Persistent storage of all traces to disk
- Network exporters that require credentials or infrastructure setup
- Automatic instrumentation of every module without explicit integration

## Trace Model

```text
Trace (root)
├── Span: session.create
│   ├── Span: task.plan
│   │   └── Span: model.qwen.route
│   ├── Span: task.execute
│   │   ├── Span: patch.generate
│   │   ├── Span: patch.apply
│   │   └── Span: test.run
│   ├── Span: task.repair
│   │   └── Span: model.deepseek.route
│   └── Span: task.review
│       └── Span: model.gpt54.verify
└── Span: session.close
```

Each trace represents one top-level user or system action. Each span represents a bounded operation with timing, attributes, status, and optional child spans.

## Core Concepts

### Trace
A complete execution flow for one task or request.

### Span
A timed unit of work within a trace.

### Span Context
The correlation payload shared across modules and async boundaries.

### Metrics
Aggregated counters, gauges, and histograms derived from spans or explicit instrumentation.

### Trace-Aware Logs
Structured log entries that include `traceId`, `spanId`, and related attributes.

## Sampling Strategy
| Environment | Suggested Sample Rate | Reason |
|-------------|-----------------------|--------|
| `development` | `1.0` | Full visibility during implementation |
| `test` | `1.0` | Easier diagnosis of failing runs |
| `production` | `0.1` | Lower overhead while preserving signal |
| `debug` | `1.0` | Explicit diagnostics mode |

Sampling should be configurable through `TelemetryConfig.sampleRate`.

## Data Model

```typescript
interface SpanContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  traceFlags: number;
  isRemote: boolean;
}

interface SpanOptions {
  parent?: SpanContext | Span;
  kind?: SpanKind;
  attributes?: TraceAttributes;
  startTime?: number;
  root?: boolean;
}

interface SpanEvent {
  name: string;
  timestamp: number;
  attributes?: TraceAttributes;
}

interface SpanRecord {
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

interface MetricPoint {
  name: string;
  type: 'counter' | 'gauge' | 'histogram';
  value: number;
  labels?: Record<string, string>;
  timestamp: number;
}

interface LogRecord {
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  timestamp: number;
  traceId?: string;
  spanId?: string;
  attributes?: Record<string, unknown>;
}
```

## API Design

### `TraceIdGenerator`
Responsible for generating and validating correlation IDs.

```typescript
interface TraceIdGenerator {
  generateTraceId(): string;
  generateSpanId(): string;
  isValidTraceId(traceId: string): boolean;
  isValidSpanId(spanId: string): boolean;
}
```

Notes:
- Use lowercase hex strings
- Target W3C-compatible lengths: 32 chars for trace IDs, 16 chars for span IDs

### `Tracer`
Main orchestration entry point.

```typescript
interface Tracer {
  startSpan(name: string, options?: SpanOptions): Span;
  startActiveSpan<T>(name: string, fn: (span: Span) => T, options?: SpanOptions): T;
  withContext<T>(context: SpanContext, fn: () => T): T;
  getActiveContext(): SpanContext | undefined;
  getFinishedSpans(): SpanRecord[];
  flush(): Promise<void>;
}
```

Responsibilities:
- Create root and child spans
- Track active context
- End spans and hand them to exporters
- Record built-in telemetry metrics

### `Span`
Represents an in-flight operation.

```typescript
interface Span {
  readonly context: SpanContext;
  readonly name: string;
  setAttribute(key: string, value: TraceAttributeValue): void;
  setAttributes(attributes: TraceAttributes): void;
  addEvent(name: string, attributes?: TraceAttributes): void;
  setStatus(status: SpanStatus): void;
  recordException(error: unknown): void;
  end(endTime?: number): SpanRecord;
  toRecord(): SpanRecord;
}
```

### `MetricsCollector`
Collects coarse-grained metrics for dashboards and regression checks.

```typescript
interface MetricsCollector {
  incrementCounter(name: string, value?: number, labels?: MetricLabels): void;
  recordGauge(name: string, value: number, labels?: MetricLabels): void;
  recordHistogram(name: string, value: number, labels?: MetricLabels): void;
  snapshot(): MetricsSnapshot;
  reset(): void;
}
```

Initial metric families to support:
- `jackcode.trace.started`
- `jackcode.trace.completed`
- `jackcode.span.duration_ms`
- `jackcode.model.request_count`
- `jackcode.model.latency_ms`
- `jackcode.task.errors`

### `TraceLogger`
Structured logger that automatically injects current trace context.

```typescript
interface TraceLogger {
  debug(message: string, attributes?: LogAttributes): void;
  info(message: string, attributes?: LogAttributes): void;
  warn(message: string, attributes?: LogAttributes): void;
  error(message: string, error?: unknown, attributes?: LogAttributes): void;
  child(defaultAttributes: LogAttributes): TraceLogger;
}
```

### `TraceExporter`
Optional interface for external systems.

```typescript
interface TraceExporter {
  export(spans: SpanRecord[]): Promise<TraceExportResult>;
  shutdown?(): Promise<void>;
}
```

Possible future implementations:
- Console exporter
- JSON file exporter
- OpenTelemetry bridge exporter
- JackClaw event stream exporter

### `TraceDiagnosticView`
Lightweight local debugging surface.

```typescript
interface TraceDiagnosticView {
  formatTrace(traceId: string, spans: SpanRecord[]): string;
  formatSpanTree(spans: SpanRecord[]): string;
  findSlowSpans(spans: SpanRecord[], thresholdMs: number): SpanRecord[];
}
```

## Context Propagation

### In-process async propagation
Use Node.js `AsyncLocalStorage<SpanContext>` so code can ask for the active trace context without manually threading it through every internal call.

### Explicit boundary propagation
For these boundaries, context should be passed explicitly:
- model router requests
- JackClaw adapter requests
- queued/retried tasks
- exported logs or events
- future remote node calls

### External compatibility
Keep a normalized `SpanContext` shape so later threads can map it to W3C `traceparent` headers or OpenTelemetry context without redesigning the core API.

## Metrics Strategy

### What to measure
- span duration
- task success/failure count
- retry count
- model routing frequency
- model/API latency
- build/test loop duration
- patch apply success rate

### Collection model
- Metrics can be emitted directly by modules
- Tracer should also derive latency metrics when spans end
- Snapshots are in-memory only for now

## Structured Logging Strategy
Each log entry should optionally include:
- `traceId`
- `spanId`
- `parentSpanId`
- `module`
- `taskId`
- `sessionId`
- `state`

Example:

```json
{
  "level": "info",
  "message": "Routing task to qwen executor",
  "traceId": "6a2c...",
  "spanId": "95ab...",
  "attributes": {
    "module": "model.router",
    "taskId": "task-123",
    "model": "qwen-3.6"
  }
}
```

## Integration Points

### Thread 01 — Runtime State Machine
- Start spans around state transitions
- Record transition metadata as span attributes/events
- Use trace IDs when reporting unrecoverable errors

### Thread 02 — Session Context
- Create root trace/span for session lifecycle events
- Attach `sessionId`, current task, checkpoint ID, and handoff metadata
- Preserve span context when tasks are paused/resumed

### Thread 03 — Patch Engine
- Wrap patch generation, validation, and application in child spans
- Emit counters for patch success/failure

### Thread 04 — Build/Test Loop
- Trace build/test command phases
- Emit histograms for command duration and test counts

### Thread 09/10/11/12 — Model Routing and Verification
- Trace each model route request and response
- Attach model name, tier, token counts, retry count, latency, escalation cause

### Thread 13/14/15 — JackClaw Adapters
- Preserve trace context across adapter boundaries
- Use trace IDs to correlate JackCode actions with JackClaw-side logs/events

### Thread 19 — Recovery / Retry / Safety
- Model retries as child spans of the failed operation
- Attach retry attempt number and backoff duration

### Thread 20 — Integration QA
- Use diagnostic views and metrics snapshots in integration reports

## File Plan
```text
src/core/telemetry.ts
  - Span context types
  - Trace ID generator
  - Span implementation
  - Tracer implementation
  - Metrics collector
  - Trace-aware logger
  - Optional exporters and diagnostic helpers
```

## Configuration

```typescript
interface TelemetryConfig {
  enabled: boolean;
  sampleRate: number;
  maxFinishedSpans: number;
  maxSpanEvents: number;
  serviceName: string;
  defaultAttributes?: TraceAttributes;
  exporter?: TraceExporter;
  logger?: Pick<Console, 'debug' | 'info' | 'warn' | 'error'>;
}
```

## Failure Handling
- Telemetry must never break the main execution path
- Export failures should be swallowed and surfaced via internal diagnostics/logging only
- Ending an already-ended span should be idempotent
- Invalid parent contexts should degrade to root spans rather than throwing when possible

## Implementation Notes for This Thread
This thread provides **design + scaffolding only**.

It intentionally leaves the following for later integration work:
- hooking spans into runtime/session/model modules
- real external exporters
- persistence and retention policies
- UI/CLI commands for trace inspection

## Future Work
- OpenTelemetry-compatible adapter layer
- distributed context over JackClaw node transport
- trace-backed performance regression detection
- richer CLI inspection commands like `jackcode trace show <id>`
- optional JSONL exporter for offline analysis

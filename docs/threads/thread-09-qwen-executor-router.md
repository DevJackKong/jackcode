# Thread 09: Qwen Executor Router

## Purpose
Primary executor model router for JackCode. Distributes execution tasks to Qwen 3.6, handles load balancing, request batching, and result aggregation.

## Responsibilities
1. **Task Routing**: Route `execute` state tasks to Qwen 3.6 with optimal context packing
2. **Load Balancing**: Distribute concurrent requests across available Qwen instances
3. **Request Batching**: Group compatible tasks for efficient batch processing
4. **Result Aggregation**: Collect and merge partial results from parallel executions
5. **Fallback Handling**: Escalate complex failures to GPT-5.4 review/recovery

## Design Decisions

### Routing Flow
```
Execute Task → Context Assembly → Token Budget Check → Route to Qwen
                                                    ↓
Result ← Aggregation ← Parallel Execute (if needed) ←┘
```

### Routing Strategy
| Scenario | Action |
|----------|--------|
| Simple edit (< 500 tokens) | Direct single-request |
| Multi-file change | Parallel per-file routing |
| Context overflow | Pre-compress via Thread 08 |
| Qwen timeout/failure | Escalate to Thread 10 |

### Concurrency Model
- Default: 3 concurrent Qwen requests per task
- Max batch size: 5 related operations
- Timeout: 60s per request, 180s per task

## Data Model

```typescript
interface QwenRouteRequest {
  taskId: string;
  context: CompressedContext;
  operations: CodeOperation[];
  priority: 'normal' | 'high' | 'critical';
  timeoutMs: number;
}

interface QwenRouteResult {
  taskId: string;
  success: boolean;
  operations: CompletedOperation[];
  metrics: ExecutionMetrics;
  escalation?: EscalationReason;
}

interface ExecutionMetrics {
  latencyMs: number;
  tokensUsed: number;
  cacheHitRatio: number;
}
```

## API

### `QwenExecutorRouter`
- `route(request: QwenRouteRequest): Promise<QwenRouteResult>` - Main entry point
- `batchRoute(requests: QwenRouteRequest[]): Promise<QwenRouteResult[]>` - Batch processing
- `canHandle(context: CompressedContext): boolean` - Capability check
- `getMetrics(): RouterMetrics` - Performance stats

### `LoadBalancer`
- `acquireSlot(): Promise<Slot>` - Get available execution slot
- `releaseSlot(slot: Slot): void` - Return slot to pool

## Integration Notes
- Consumes from **runtime state machine** (Thread 01) - specifically `execute` state
- Receives compressed context from **context-compressor** (Thread 08)
- Escalates complex repairs to the legacy Thread 10 notes (historical) and active GPT-5.4 recovery path
- Outputs to **review** state for **gpt54-verifier-repairer** (Thread 11)

## File Structure
```
src/model/
  router.ts          # Main router implementation
  types.ts           # Router-specific types
  load-balancer.ts   # Concurrency management (v0.2)
```

## Dependencies
- Qwen 3.6 API client (via adapter)
- Context compressor (Thread 08)
- Runtime state machine (Thread 01)

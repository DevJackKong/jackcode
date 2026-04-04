# Thread 19: Recovery-Retry-Safety

## Purpose
Provides resilience, retry logic, and safety guardrails for JackCode. Ensures failed operations can be retried intelligently, critical failures trigger recovery mechanisms, and safety limits prevent runaway behavior or cascading failures.

## Responsibilities
1. **Retry Logic**: Exponential backoff with jitter for transient failures
2. **Circuit Breaker**: Prevent cascading failures by halting repeated failing operations
3. **Recovery Mechanisms**: Automatic rollback, state restoration, and escalation on critical failures
4. **Safety Guardrails**: Limits on retries, timeouts, and resource consumption
5. **Failure Classification**: Distinguish transient vs permanent vs safety violations

## Design Decisions

### Retry Strategy
```
Attempt → Failure Detected → Classify → Retry (with backoff) → Success/Max Retries
```

### Retry Configuration
| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxRetries` | 3 | Maximum retry attempts per operation |
| `baseDelayMs` | 1000 | Initial delay between retries |
| `maxDelayMs` | 30000 | Maximum delay cap |
| `backoffMultiplier` | 2 | Exponential backoff factor |
| `jitter` | true | Add random jitter to prevent thundering herd |
| `retryableErrors` | [] | Error types eligible for retry |

### Circuit Breaker States
```
CLOSED → OPEN → HALF_OPEN → CLOSED
  ↑         ↓
Success   Failure Threshold
```

| State | Behavior |
|-------|----------|
| `CLOSED` | Normal operation, requests pass through |
| `OPEN` | Failing fast, all requests rejected immediately |
| `HALF_OPEN` | Limited probe requests allowed to test recovery |

### Circuit Breaker Configuration
| Parameter | Default | Description |
|-----------|---------|-------------|
| `failureThreshold` | 5 | Failures before opening circuit |
| `successThreshold` | 3 | Successes to close from half-open |
| `timeoutMs` | 60000 | Time before attempting half-open |

### Failure Classification
```typescript
type FailureCategory = 
  | 'transient'      // Network errors, rate limits, timeouts - retryable
  | 'permanent'      // Syntax errors, logic errors - don't retry
  | 'safety'         // Resource exhaustion, loop detected - halt
  | 'unknown';       // Requires classification
```

### Recovery Levels
| Level | Trigger | Action |
|-------|---------|--------|
| `retry` | Transient failure | Retry with backoff |
| `rollback` | Permanent failure after retries | Revert to checkpoint |
| `escalate` | Repeated failures | Handoff to reasoner |
| `halt` | Safety violation | Stop all operations |

### Safety Guardrails
| Guardrail | Description |
|-----------|-------------|
| `maxRetriesPerTask` | Global retry limit per task |
| `maxConcurrentRetries` | Concurrent retry limit |
| `totalTimeoutMs` | Absolute deadline for task |
| `memoryLimitMb` | Memory consumption cap |
| `loopDetection` | Detect infinite retry loops |

## API

### `RetryManager`
- `execute<T>(operation: Operation<T>, config?: RetryConfig): Promise<T>` - Execute with retry
- `classifyError(error: unknown): FailureCategory` - Classify failure type
- `calculateDelay(attempt: number, config: RetryConfig): number` - Compute backoff delay

### `CircuitBreaker`
- `call<T>(operation: () => Promise<T>): Promise<T>` - Execute through circuit breaker
- `recordSuccess(): void` - Mark operation success
- `recordFailure(): void` - Mark operation failure
- `getState(): CircuitState` - Current circuit state

### `RecoveryEngine`
- `attemptRecovery(context: RecoveryContext): Promise<RecoveryResult>` - Attempt recovery
- `rollbackToCheckpoint(sessionId: string, checkpointId: string): Promise<boolean>` - Restore state
- `escalateToReasoner(context: EscalationContext): Promise<void>` - Escalate to DeepSeek

### `SafetyGuardian`
- `checkLimits(context: ExecutionContext): SafetyCheck` - Validate safety constraints
- `enforceGuardrails(context: ExecutionContext): boolean` - Apply hard limits
- `detectLoop(pattern: string[]): boolean` - Detect retry loops

## Integration Notes
- **Input from**: Thread 01 (Runtime) when `state === 'failed'`
- **Input from**: Thread 04 (Build-Test Loop) for build/test failures
- **Input from**: Thread 11 (Verifier) for verification failures
- **Output to**: Thread 01 (Runtime) for state transitions
- **Output to**: Thread 10 (DeepSeek Reasoner) for escalations
- **Uses**: Thread 02 (Session) for checkpoint restoration
- **Uses**: Thread 03 (Patch Engine) for rollback operations

## File Structure
```
src/core/
  repairer.ts           # Main recovery/retry/safety implementation
src/types/
  repairer.ts           # Recovery/retry/safety types
```

## Dependencies
- Circuit breaker pattern implementation
- Exponential backoff with jitter algorithm
- Session checkpoint system (Thread 02)
- Patch rollback system (Thread 03)
- Model router for escalations (Thread 10)

## Configuration
```typescript
interface RecoveryConfig {
  retry: RetryConfig;
  circuitBreaker: CircuitBreakerConfig;
  safety: SafetyConfig;
}

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
  jitter: boolean;
  retryableErrors: string[];
}

interface CircuitBreakerConfig {
  failureThreshold: number;
  successThreshold: number;
  timeoutMs: number;
}

interface SafetyConfig {
  maxRetriesPerTask: number;
  maxConcurrentRetries: number;
  totalTimeoutMs: number;
  memoryLimitMb: number;
  enableLoopDetection: boolean;
}
```

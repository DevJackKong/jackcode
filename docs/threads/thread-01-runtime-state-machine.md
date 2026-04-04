# Thread 01: Runtime State Machine

## Purpose
Defines the core task execution lifecycle for JackCode. Manages state transitions for plan → execute → repair → review.

## States

```
┌─────────┐    ┌──────────┐    ┌─────────┐    ┌─────────┐
│  PLAN   │───▶│ EXECUTE  │───▶│ REVIEW  │───▶│  DONE   │
└─────────┘    └────┬─────┘    └─────────┘    └─────────┘
                    │
                    ▼
              ┌─────────┐
              │ REPAIR  │───▶ (back to EXECUTE)
              └─────────┘
```

### State Definitions

| State | Purpose | Entry Condition |
|-------|---------|-----------------|
| `plan` | Analyze task, create execution strategy | Task received |
| `execute` | Run the actual code changes | Plan approved |
| `repair` | Fix failures from execute | Execute failed |
| `review` | Verify changes meet requirements | Execute succeeded |

### Transitions

- `plan` → `execute`: Plan created and validated
- `execute` → `review`: All changes applied successfully
- `execute` → `repair`: Build/test failure or error
- `repair` → `execute`: Repair patch applied
- `review` → `done`: Changes verified
- Any → `error`: Unrecoverable failure

## Data Model

```typescript
interface TaskContext {
  id: string;
  state: TaskState;
  intent: string;
  plan?: ExecutionPlan;
  attempts: number;
  maxAttempts: number;
  artifacts: Artifact[];
  errors: ErrorLog[];
}

interface ExecutionPlan {
  steps: PlanStep[];
  estimatedTokens: number;
  targetModel: ModelTier;
}
```

## Integration Notes

- Thread 02 (session-context): Reads/writes session state
- Thread 09 (qwen-executor-router): Receives execute state tasks
- Thread 10 (deepseek-reasoner-router): Receives repair state escalations
- Thread 11 (gpt54-verifier-repairer): Receives review state tasks

## Files

- `src/core/runtime.ts` - State machine implementation
- `src/types/runtime.ts` - Type definitions (if needed)

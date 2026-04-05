# Thread 12: Model Policy & Cost Control

## Purpose
Central policy engine for model selection, routing rules, and cost management. Determines which model (Qwen/GPT-5.4) to invoke based on task characteristics, enforces budget constraints, and optimizes cost-performance tradeoffs.

## Responsibilities
1. **Model Selection Policy**: Decide which model handles each task type based on complexity, urgency, and accuracy requirements
2. **Routing Rule Engine**: Execute routing rules with priority and fallback chains
3. **Cost Budgeting**: Track and enforce per-session, per-task, and daily cost limits
4. **Token Accounting**: Monitor token usage across models and estimate costs
5. **Smart Fallback**: Escalate to higher-capability models only when justified by cost-benefit analysis

## Design Decisions

### Model Capability Matrix
| Model | Strengths | Cost/T1K | Best For | Max Context |
|-------|-----------|----------|----------|-------------|
| Qwen 3.6 | Fast execution, coding | $0.002 | Standard edits, batch ops | 128K |
| GPT-5.4 | High accuracy, verification | $0.03 | Final review, critical fixes | 256K |

### Routing Decision Flow
```
Task Received
    ↓
[Policy Engine]
    ↓
Classify Task ──→ Estimate Complexity ──→ Check Budget ──→ Select Model
                                              ↓
                                          Budget OK?
                                     No ──→ Force Downgrade
                                              ↓
                                    Route to Selected Model
                                              ↓
                                    Track Cost & Tokens
```

### Cost Control Strategy
| Scenario | Action |
|----------|--------|
| Budget < 50% | Normal routing |
| Budget 50-80% | Prefer cheaper models |
| Budget 80-95% | Require approval for expensive models |
| Budget > 95% | Block GPT-5.4, queue for review |
| Token overflow predicted | Pre-compress context |

### Policy Rules (Priority Order)
1. **Critical Path Rule**: Build/test failures always route to cheapest capable model first
2. **Escalation Rule**: After 2 failures, upgrade to next model tier
3. **Cost Cap Rule**: Single task max $0.50, session max $5.00, daily max $20.00
4. **Caching Rule**: Reuse previous model choice for identical task signatures
5. **Batch Rule**: Group similar tasks for bulk Qwen processing

## Data Model

```typescript
interface ModelPolicy {
  defaultModel: 'qwen' | 'gpt54';
  complexityThresholds: {
    low: number;     // Simple edits
    medium: number;  // Multi-file changes
    high: number;    // Complex reasoning
  };
  costLimits: {
    perTask: number;
    perSession: number;
    perDay: number;
  };
  escalationChain: ['qwen', 'gpt54'];
}

interface RoutingDecision {
  taskId: string;
  selectedModel: ModelTier;
  reasoning: string;
  estimatedCost: number;
  estimatedTokens: number;
  fallbackOnFailure: boolean;
}

interface CostTracker {
  sessionId: string;
  taskCosts: Map<string, TaskCost>;
  sessionTotal: number;
  dailyTotal: number;
  lastReset: number;
}

interface TaskCost {
  model: ModelTier;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}
```

## API

### `ModelPolicyEngine`
- `selectModel(task: TaskContext): RoutingDecision` - Determine optimal model
- `checkBudget(cost: number): BudgetStatus` - Verify cost against limits
- `trackUsage(taskId: string, usage: TokenUsage)` - Record actual usage
- `getCostReport(): CostReport` - Generate spending summary
- `enforceLimits(decision: RoutingDecision): RoutingDecision` - Apply constraints

### `RoutingRules`
- `evaluate(rules: PolicyRule[], context: TaskContext): RuleResult[]` - Execute rule chain
- `addRule(rule: PolicyRule): void` - Register custom policy
- `cacheDecision(signature: string, decision: RoutingDecision): void` - Memoize choices

### `CostController`
- `allocateBudget(taskType: TaskType): BudgetAllocation` - Reserve funds
- `charge(taskId: string, actual: TaskCost): void` - Debit actual spend
- `refund(taskId: string): void` - Return unused allocation
- `getRemainingBudget(): BudgetSnapshot` - Current limits status

## Integration Notes
- Consumes task context from **runtime state machine** (Thread 01)
- Routes to **qwen-executor-router** (Thread 09) for standard tasks
- Escalates via the GPT-5.4 recovery path for failures; Thread 10 is historical only
- Final verification via **gpt54-verifier-repairer** (Thread 11, planned)
- Reports costs to session manager for budgeting

## File Structure
```
src/model/
  policy.ts          # Policy engine and routing decisions
  types/
    policy.ts        # Policy-specific types
  cost/
    tracker.ts       # Cost tracking implementation (v0.2)
    limits.ts        # Budget limit enforcement (v0.2)
```

## Dependencies
- Model routers (Thread 09, 10, 11)
- Runtime state machine (Thread 01)
- Session context (Thread 02)

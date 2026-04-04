# Thread 10: DeepSeek Reasoner Router

## Purpose
Escalation reasoning engine for failed executions. DeepSeek-R1 specializes in deep reasoning for complex problem analysis, making it ideal for diagnosing build/test failures and generating repair strategies.

## Responsibilities
1. **Failure Analysis**: Deep reasoning on why execution failed (syntax errors, test failures, dependency issues)
2. **Root Cause Identification**: Trace failures back to specific code changes or missing context
3. **Repair Strategy Generation**: Create structured repair plans with confidence scoring
4. **Escalation Hooks**: Provide reasoning callbacks for the repair state in runtime

## Design Decisions

### Reasoning Pipeline
```
Failure Input → Context Analysis → Root Cause Reasoning → Repair Strategy → Confidence Score → Output
```

### Escalation Triggers
| Trigger | Description |
|---------|-------------|
| `build_failed` | Compilation/type errors after code changes |
| `test_failed` | Test suite failures |
| `dependency_error` | Missing imports, broken refs |
| `logic_error` | Runtime exceptions, unexpected behavior |

### Reasoning Hooks
```typescript
// Hook called when entering repair state
type ReasoningHook = (
  context: RepairContext
) => Promise<ReasoningResult>;
```

### Confidence Levels
| Level | Score | Action |
|-------|-------|--------|
| High | ≥0.8 | Auto-apply repair |
| Medium | 0.5-0.8 | Apply with warning |
| Low | <0.5 | Escalate to human |

## API

### `DeepSeekReasonerRouter`
- `analyzeFailure(context: RepairContext): Promise<ReasoningResult>` - Main reasoning entry point
- `generateRepairStrategy(analysis: FailureAnalysis): RepairStrategy` - Create repair plan
- `scoreConfidence(strategy: RepairStrategy): number` - Calculate confidence score

### `RepairContext`
- `taskId`: string - Reference to original task
- `errors`: ErrorLog[] - Collected errors from execution
- `artifacts`: Artifact[] - Files/patches from execution attempt
- `context`: CompressedContext - Relevant compressed context

### `ReasoningResult`
- `rootCause`: string - Identified root cause
- `strategy`: RepairStrategy - Proposed fix
- `confidence`: number - 0-1 confidence score
- `reasoningChain`: string[] - Explainability trace

## Integration Notes
- **Input from**: Thread 01 (Runtime State Machine) when `state === 'repair'`
- **Input from**: Thread 04 (Build-Test Loop) for failure details
- **Output to**: Thread 01 (Runtime) for repair execution
- **Uses**: Thread 08 (Context Compressor) for relevant context

## File Structure
```
src/model/
  providers/
    deepseek.ts           # Main router implementation
  types/
    reasoning.ts          # Reasoning-specific types
```

## Dependencies
- DeepSeek API (R1 reasoning model)
- Context from context-compressor (Thread 08)
- Error logs from runtime (Thread 01)

## Configuration
```typescript
interface DeepSeekConfig {
  model: 'deepseek-reasoner' | 'deepseek-chat';
  maxReasoningTokens: number;
  temperature: number;  // Lower for deterministic reasoning
  timeoutMs: number;
}
```

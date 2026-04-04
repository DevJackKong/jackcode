# Integration Smoke Tests

## Overview
This document defines the integration smoke test suite for JackCode. Tests are organized by thread interactions and end-to-end flows.

## Test Execution

```bash
# Run all smoke tests
npm run test:integration:smoke

# Run specific thread pair
npm run test:integration -- --pair thread-01,thread-09

# Run specific flow
npm run test:integration -- --flow happy-path
```

## Thread Pair Tests

### TP-01: Runtime → Session (Thread 01 ↔ Thread 02)
**Purpose**: Verify task state persistence

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-01-1 | State save on transition | Create task → Transition to execute | State persisted to session |
| TP-01-2 | State restore | Load task by ID | Full context restored |
| TP-01-3 | Concurrent updates | Two transitions in parallel | No race conditions |

### TP-02: Runtime → Qwen Router (Thread 01 ↔ Thread 09)
**Purpose**: Verify execute state routing

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-02-1 | Execute routing | Task in execute state | Routed to Qwen handler |
| TP-02-2 | Model selection | Task with plan | Correct model tier selected |
| TP-02-3 | Result handling | Qwen returns result | State transitions to review |

### TP-03: Runtime → DeepSeek Router (Thread 01 ↔ Thread 10)
**Purpose**: Verify repair escalation

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-03-1 | Repair escalation | Execute fails | Routed to DeepSeek handler |
| TP-03-2 | Repair success | DeepSeek returns fix | State returns to execute |
| TP-03-3 | Max attempts | 3 repair attempts | State transitions to error |

### TP-04: Runtime → GPT-5.4 Verifier (Thread 01 ↔ Thread 11)
**Purpose**: Verify review gate

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-04-1 | Review routing | Task in review state | Routed to verifier |
| TP-04-2 | Approve path | All checks pass | State transitions to done |
| TP-04-3 | Reject path | Critical issues | State returns to repair |

### TP-05: Patch Engine → Build-Test (Thread 03 ↔ Thread 04)
**Purpose**: Verify post-patch validation

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-05-1 | Build trigger | Patch applied | Build test runs |
| TP-05-2 | Incremental | Single file change | Only affected tests run |
| TP-05-3 | Failure handling | Build fails | Error reported to runtime |

### TP-06: Symbol Index → Impact Analyzer (Thread 06 ↔ Thread 07)
**Purpose**: Verify impact analysis

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-06-1 | Symbol lookup | Query for symbol | Index returns references |
| TP-06-2 | Impact calculation | File change detected | Dependent files identified |
| TP-06-3 | Cascade analysis | Multi-hop dependencies | Full impact tree built |

### TP-07: Context Compressor → Models (Thread 08 ↔ Thread 09-11)
**Purpose**: Verify context delivery

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-07-1 | Compression | Large context | Compressed within limits |
| TP-07-2 | Relevance | Irrelevant history | Trimmed, key info kept |
| TP-07-3 | Decompression | Model receives | Full context recoverable |

### TP-08: Cost Control → Model Router (Thread 12 ↔ Thread 09-11)
**Purpose**: Verify model selection

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-08-1 | Budget check | Task exceeds budget | Appropriate model selected |
| TP-08-2 | Token estimation | Plan created | Token estimate accurate |
| TP-08-3 | Cost tracking | Multiple tasks | Accurate cost accumulation |

### TP-09: JackClaw Adapters → Runtime (Thread 13-15 ↔ Thread 01)
**Purpose**: Verify JackClaw integration

| Test ID | Scenario | Steps | Expected |
|---------|----------|-------|----------|
| TP-09-1 | Node connection | JackClaw task received | Properly ingested |
| TP-09-2 | Memory sync | Task completes | Memory updated |
| TP-09-3 | Collaboration | Multi-user task | Coordination works |

## End-to-End Flow Tests

### Flow-01: Happy Path
**Purpose**: Complete successful task lifecycle

```
[Start] → Create Task → Plan → Execute → Review → Done → [End]
```

| Step | Action | Verification |
|------|--------|--------------|
| 1 | Create task with intent | Task ID returned, state=plan |
| 2 | Generate execution plan | Plan created, state=execute |
| 3 | Execute with Qwen | Changes applied, state=review |
| 4 | Verify with GPT-5.4 | Approval received, state=done |
| 5 | Finalize task | Artifacts persisted |

### Flow-02: Repair Loop
**Purpose**: Execute failure and recovery

```
[Start] → Execute → Fail → Repair → Re-execute → Success → Review → Done → [End]
```

| Step | Action | Verification |
|------|--------|--------------|
| 1 | Execute task | Build fails |
| 2 | Transition to repair | Routed to DeepSeek |
| 3 | Apply repair | Fix applied, state=execute |
| 4 | Re-execute | Success, state=review |
| 5 | Complete review | State=done |

### Flow-03: Max Attempts
**Purpose**: Exhaust retry budget

```
[Start] → Execute → Fail → Repair → Execute → Fail → Repair → Execute → Fail → Error → [End]
```

| Step | Action | Verification |
|------|--------|--------------|
| 1 | Execute (attempt 1) | Fail |
| 2 | Repair (attempt 1) | Fix applied |
| 3 | Execute (attempt 2) | Fail |
| 4 | Repair (attempt 2) | Fix applied |
| 5 | Execute (attempt 3) | Fail |
| 6 | Transition to error | No more attempts allowed |

### Flow-04: Context Overflow
**Purpose**: Large context handling

```
[Start] → Large intent → Compress → Process → [End]
```

| Step | Action | Verification |
|------|--------|--------------|
| 1 | Create task with large context | Context detected |
| 2 | Compress context | Within token limits |
| 3 | Process with model | Results accurate |
| 4 | Decompress if needed | Full context recoverable |

### Flow-05: Multi-file Change
**Purpose**: Complex change coordination

```
[Start] → Scan → Analyze → Patch → Validate → [End]
```

| Step | Action | Verification |
|------|--------|--------------|
| 1 | Repository scan | Symbol index built |
| 2 | Impact analysis | Affected files identified |
| 3 | Batch patch application | All files modified |
| 4 | Build-test validation | All tests pass |
| 5 | Final verification | Changes approved |

## Test Data

### Mock Tasks
```typescript
const mockTask = {
  id: 'test-task-001',
  intent: 'Add TypeScript interface for user authentication',
  targetFiles: ['src/auth/types.ts'],
  expectedOutcome: 'New interface defined'
};

const mockLargeTask = {
  id: 'test-task-002',
  intent: 'Refactor entire module',
  context: '<very large context>',
  tokenEstimate: 50000
};
```

### Mock Patches
```typescript
const mockPatch = {
  path: 'src/auth/types.ts',
  changeType: 'added',
  content: 'export interface AuthUser { ... }'
};
```

## Success Criteria

All smoke tests must pass for release:
- 100% of P0 thread pair tests passing
- 100% of end-to-end flow tests passing
- No test flakes (3 consecutive passes)
- Execution time < 5 minutes total

# Thread 20: Integration QA

## Purpose
End-to-end integration testing framework and quality assurance matrix for JackCode. Ensures all threads work together correctly, validates release readiness, and maintains quality gates before deployment.

## Goals
- Automated integration smoke tests for all thread interactions
- QA matrix covering functional, performance, and compatibility checks
- Clear release criteria with pass/fail gates
- Regression detection across thread boundaries

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    IntegrationQAEngine                          │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ SmokeTests  │  │  QAMatrix   │  │   ReleaseValidator      │  │
│  │   Runner    │  │  Generator  │  │      Engine             │  │
│  └─────────────┘  └─────────────┘  └─────────────────────────┘  │
├─────────────────────────────────────────────────────────────────┤
│              IntegrationRegistry + TestOrchestrator             │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### 1. SmokeTestRunner
Executes critical path integration tests across all threads:
- **Thread Pair Tests**: Validates interactions between dependent threads
- **End-to-End Flows**: Full task lifecycle from plan → execute → review → done
- **Failure Recovery**: Tests error paths and recovery mechanisms

### 2. QAMatrixGenerator
Produces comprehensive quality assessment matrix:
| Dimension | Test Scope | Pass Criteria |
|-----------|-----------|---------------|
| Functional | All API contracts | 100% interface compliance |
| Integration | Thread interactions | All pairs tested |
| Performance | Latency, throughput | < target thresholds |
| Reliability | Error handling | Graceful degradation |
| Compatibility | JackClaw interop | Protocol compliance |

### 3. ReleaseValidatorEngine
Validates release readiness against criteria:
- All smoke tests passing
- No critical or high severity issues
- Performance benchmarks met
- Documentation complete

## Integration Test Matrix

### Thread Interaction Tests

| From Thread | To Thread | Test Scenario | Priority |
|------------|-----------|---------------|----------|
| 01 (Runtime) | 02 (Session) | State persistence | P0 |
| 01 (Runtime) | 09 (Qwen) | Execute routing | P0 |
| 01 (Runtime) | 10 (DeepSeek) | Repair escalation | P0 |
| 01 (Runtime) | 11 (GPT-5.4) | Review routing | P0 |
| 03 (Patch) | 04 (Build-Test) | Post-patch validation | P0 |
| 04 (Build-Test) | 11 (GPT-5.4) | Test result delivery | P0 |
| 06 (Symbol) | 07 (Impact) | Symbol → impact analysis | P1 |
| 07 (Impact) | 03 (Patch) | Impact-guided patching | P1 |
| 08 (Context) | 09-11 (Models) | Context delivery | P1 |
| 12 (Cost) | 09-11 (Models) | Model selection | P1 |
| 13-15 (Adapters) | 01 (Runtime) | JackClaw integration | P0 |

### End-to-End Flow Tests

1. **Happy Path**: Task → Plan → Execute → Review → Done
2. **Repair Loop**: Execute failure → Repair → Re-execute → Success
3. **Max Attempts**: Execute → Repair → Execute → Repair → Error
4. **Context Overflow**: Large context → Compression → Processing
5. **Multi-file Change**: Impact analysis → Batch patching → Validation

## API

```typescript
// Run all integration smoke tests
await integrationQA.runSmokeTests({ parallel: true });

// Generate QA matrix report
const matrix = await qaMatrix.generate({ format: 'markdown' });

// Validate release readiness
const releaseCheck = await releaseValidator.validate({
  criteria: ReleaseCriteria.STANDARD,
  strictMode: true
});

// Run specific thread pair test
await smokeTests.runPairTest('thread-01', 'thread-09', {
  scenario: 'execute-routing'
});
```

## Release Criteria

### P0 (Must Pass)
- [ ] All smoke tests passing
- [ ] No critical bugs
- [ ] Core flows functional (plan → execute → review → done)
- [ ] TypeScript compilation clean
- [ ] Unit test coverage ≥ 80%

### P1 (Should Pass)
- [ ] No high severity bugs
- [ ] Integration test coverage ≥ 70%
- [ ] Performance benchmarks met
- [ ] Documentation complete for all threads
- [ ] JackClaw adapter tests passing

### P2 (Nice to Have)
- [ ] Medium severity bugs documented
- [ ] Load testing completed
- [ ] Security scan clean
- [ ] Accessibility guidelines met

## Integration Notes
- **Input from**: All threads (via IntegrationRegistry)
- **Uses**: Thread 04 (Build-Test) for test execution
- **Uses**: Thread 11 (GPT-5.4) for quality assessment
- **Reports to**: Thread 13 (JackClaw Node Adapter) for CI integration
- **Output**: QA reports, release readiness status

## File Structure
```
tests/
  integration-smoke.md      # Smoke test specifications
docs/threads/
  thread-20-integration-qa.md  # This document
```

## Dependencies
- Thread 01 (Runtime) for task lifecycle hooks
- Thread 04 (Build-Test) for test execution
- Thread 13-15 (Adapters) for JackClaw compatibility

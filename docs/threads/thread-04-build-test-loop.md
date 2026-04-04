# Thread 04: Build-Test-Loop

## Overview
Automated build, test, and lint orchestration for JackCode. Provides fast feedback cycles with intelligent caching, incremental runs, and failure recovery.

## Goals
- Sub-second incremental test runs
- Intelligent test selection based on code changes
- Parallel execution with resource-aware throttling
- Unified interface for build/test/lint operations

## Architecture

```
┌─────────────────────────────────────────────┐
│           BuildTestLoopOrchestrator         │
├─────────────────────────────────────────────┤
│  ┌─────────────┐ ┌─────────────┐ ┌────────┐ │
│  │ BuildRunner │ │ TestRunner  │ │ Linter │ │
│  └─────────────┘ └─────────────┘ └────────┘ │
├─────────────────────────────────────────────┤
│        CacheManager + DependencyGraph       │
└─────────────────────────────────────────────┘
```

## Components

### 1. BuildRunner
- TypeScript compilation via `tsc --incremental`
- esbuild for fast dev builds
- Output caching with content hashing

### 2. TestRunner
- Test discovery with glob patterns
- Incremental test selection (only changed + dependents)
- Parallel worker pool with configurable concurrency
- Supports: Vitest, Jest, Node test runner

### 3. Linter
- ESLint/Prettier integration
- Staged file linting for speed
- Auto-fix with failure reporting

### 4. CacheManager
- File-based caching with mtime validation
- Dependency graph tracking
- Cache invalidation on config changes

## API

```typescript
// Run full CI pipeline
await orchestrator.run({ incremental: true });

// Run specific targets
await testRunner.run({ pattern: 'src/core/**', watch: false });
await buildRunner.compile({ target: 'es2022', outDir: 'dist' });
await linter.lint({ fix: true, stagedOnly: false });
```

## Integration Notes
- Thread 03 (PatchEngine): Trigger test runs on patch application
- Thread 13 (JackClawNodeAdapter): Report results to JackClaw node
- Thread 18 (TraceObservability): Emit build/test metrics

## Future Work
- Remote caching for CI/CD
- Test sharding across workers
- Flaky test detection and quarantine

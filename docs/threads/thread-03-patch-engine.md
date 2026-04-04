# Thread 03: Patch Engine

## Overview
The Patch Engine is responsible for planning, executing, and managing code patches with full rollback support. It generates intelligent diff summaries and maintains a history of applied changes for safe recovery.

## Responsibilities

1. **Patch Planning**: Analyze target changes and create structured execution plans
2. **Diff Summaries**: Generate human-readable and machine-parseable change summaries
3. **Rollback Support**: Maintain snapshots and reverse-applicable patches for recovery

## Design Decisions

### Patch Structure
- Atomic patches: Each patch is self-contained and reversible
- Hierarchical planning: Patches can contain sub-patches for complex changes
- Metadata-rich: Every patch carries context, rationale, and rollback info

### Diff Strategy
- Line-based diffs with context awareness
- Syntax-aware for supported languages (TypeScript, Python, etc.)
- Minimize hunks to reduce merge conflicts

### Rollback Model
- Pre-patch snapshots stored as reverse diffs
- Rollback queue for multi-step recovery
- Garbage collection for old snapshots (configurable retention)

## Interface

```typescript
// Core patch operations
interface PatchEngine {
  plan(changes: ChangeRequest[]): PatchPlan;
  apply(plan: PatchPlan): Promise<PatchResult>;
  rollback(patchId: string): Promise<RollbackResult>;
  summarize(diff: Diff): DiffSummary;
}
```

## Integration Notes

- **Runtime State Machine (Thread 01)**: Patches trigger state transitions
- **Session Context (Thread 02)**: Session-scoped patch history
- **Build-Test Loop (Thread 04)**: Patches validated before permanent apply
- **Repo Scanner (Thread 05)**: File discovery for patch targets

## File Locations

- Implementation: `src/tools/patch.ts`
- Types: `src/types/patch.ts`

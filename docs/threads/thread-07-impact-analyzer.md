# Thread 07: Impact Analyzer

## Purpose
Analyze the ripple effects of code changes to determine what files, symbols, and dependencies are affected by a given modification. This enables targeted testing, precise context gathering, and safe refactoring.

## Responsibilities
1. **Change Ingestion**: Accept git diffs, file modifications, or symbol changes as input
2. **Dependency Graph Traversal**: Navigate import/export relationships to find affected code
3. **Impact Classification**: Categorize impact severity (direct, transitive, test-only, etc.)
4. **Test Discovery**: Identify which tests need to run based on changed code
5. **Context Boundary**: Determine the minimal context needed for a change

## Design

### Core Interface
```typescript
interface ImpactAnalyzer {
  analyze(change: ChangeDescriptor): Promise<ImpactReport>;
  invalidateCache(paths?: string[]): void;
}
```

### Key Types
- `ChangeDescriptor`: What changed (file, range, type of change)
- `ImpactReport`: Affected files, symbols, tests, severity assessment
- `ImpactGraph`: Directed graph of dependencies for traversal

### Implementation Strategy
1. **Static Analysis Layer**: Parse imports/exports using AST (TypeScript compiler API or swc)
2. **Graph Builder**: Construct in-memory dependency graph from repo state
3. **Change Resolver**: Map file changes to affected symbols
4. **Impact Propagator**: Traverse graph to find all downstream dependencies
5. **Test Mapper**: Associate source files with their test files

### Integration Points
- **Consumes**: Symbol index (Thread 06), repo scanner (Thread 05)
- **Provides**: Impact reports to context compressor (Thread 08), patch engine (Thread 03)

## Files
- `src/repo/impact-analyzer.ts` - Main implementation
- `src/types/impact-analyzer.ts` - Type definitions

## Status
Scaffold complete. Awaiting symbol index integration.

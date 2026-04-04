# Thread 06: Symbol Import Index

## Purpose
Build a lightweight index mapping symbols (functions, classes, interfaces, types) to their import dependencies and reverse dependencies. Enables accurate impact analysis, dead code detection, and safe refactoring suggestions.

## Responsibilities
1. Parse TypeScript/JavaScript files and extract:
   - Exported symbols (functions, classes, interfaces, types, consts)
   - Import statements and their resolved paths
   - Symbol-to-file and file-to-symbol mappings
2. Build bi-directional index: symbol definitions ↔ symbol usages
3. Support incremental updates when files change
4. Provide query API for:
   - "Where is this symbol defined?"
   - "What files import this symbol?"
   - "What does this file depend on?"

## Design Decisions

### Scope
- Focus on ES modules (`import`/`export`) and TypeScript
- Skip deep type analysis (leave to TypeScript compiler API if needed)
- Support relative imports, path aliases (via tsconfig paths), and npm packages

### Index Structure
```typescript
SymbolIndex {
  definitions: Map<symbolId, SymbolDefinition>
  imports: Map<filePath, ImportEntry[]>
  exports: Map<filePath, ExportEntry[]>
  reverseImports: Map<symbolId, Set<filePath>>  // reverse lookup
}
```

### Parsing Strategy
- Use `typescript` parser for AST extraction
- Single-pass file analysis: collect imports + exports simultaneously
- Cache parsed ASTs with file hash for incremental updates

### Incremental Updates
- File watcher provides changed file path + content hash
- Re-parse only changed files
- Update indexes atomically per batch

## API Sketch

```typescript
// Build index from project root
const index = await SymbolIndex.build(rootDir, tsConfigPath);

// Query APIs
index.resolveSymbol(symbolName, fromFile): SymbolDefinition | null;
index.getImports(filePath): ImportEntry[];
index.getImporters(symbolId): string[];
index.getDependencies(filePath): string[];  // transitive deps

// Incremental update
index.updateFile(filePath, newContent): void;
index.removeFile(filePath): void;

// Persistence
index.save(cachePath): Promise<void>;
index.load(cachePath): Promise<SymbolIndex>;
```

## Types
See `src/types/symbol-index.ts` for full type definitions.

## Integration Notes
- **Thread 05 (repo-scanner)**: Provides file list and change events
- **Thread 07 (impact-analyzer)**: Consumes this index for change impact calculation
- **Thread 03 (patch-engine)**: Uses for safe refactoring (find all usages)

## Future Work
- Add support for dynamic imports (`import()`)
- Support re-exports (`export * from './module'`)
- Add symbol usage location (line numbers) for precise refactor preview

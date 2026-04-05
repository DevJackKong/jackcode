# Thread 05: Repo Scanner

## Purpose
Provide repository scanning and analysis for JackCode. The scanner is responsible for walking the working tree, indexing files, detecting languages, extracting dependency manifests and git metadata, and computing baseline repository statistics that other modules can reuse.

## Responsibilities
1. Traverse the repository file system safely and efficiently
2. Build a normalized file index for later lookups and incremental refreshes
3. Detect file language from extension, shebang, and light content heuristics
4. Parse common dependency manifests and expose dependency summaries
5. Extract git metadata such as current branch, recent commits, and status hints
6. Compute repository statistics including LOC and file counts by language/extension
7. Respect ignore rules from `.gitignore` plus JackCode-specific custom patterns

## Design Goals
- **Fast first scan** for small and medium repositories
- **Deterministic output** so downstream modules can diff index snapshots reliably
- **Graceful degradation** when git is unavailable or the folder is not a git repo
- **Incremental-friendly** structure for future watch mode and partial refreshes
- **Low coupling** to keep scanner usable by repo, runtime, and adapter layers

## Non-Goals (Initial Scaffold)
- Full AST-level dependency graphing (Thread 06 owns symbol/import indexing)
- File watching daemon
- Remote package registry lookups
- Advanced blame/ownership analytics
- Language-specific complexity analysis beyond basic line statistics

## High-Level Flow

```text
Repo root
  -> load scanner config
  -> load ignore rules (.gitignore + custom patterns)
  -> traverse directories
  -> classify files
  -> detect language
  -> compute file stats/hash metadata
  -> parse dependency manifests
  -> query git metadata
  -> assemble FileIndex + RepoScanResult
```

## Core Data Model

### `RepoScanner`
Primary orchestration class. Owns configuration, ignore handling, traversal, metadata extraction, and final aggregation.

### `FileIndex`
Normalized snapshot of the repository at a point in time.

```typescript
interface FileIndex {
  rootDir: string;
  generatedAt: number;
  files: Map<string, FileEntry>;
  directories: Map<string, DirectoryEntry>;
  languages: Map<string, LanguageSummary>;
  dependencies: DependencySummary[];
  stats: RepoStats;
  git: GitMetadata | null;
  ignoredPatterns: string[];
}
```

### `FileEntry`
Metadata for an indexed file.

```typescript
interface FileEntry {
  path: string;
  absolutePath: string;
  extension: string;
  language: string | null;
  size: number;
  modifiedAt: number;
  hash?: string;
  isBinary: boolean;
  stats?: FileStats;
  dependencyManifest?: boolean;
}
```

### `RepoScanResult`
Composite return type for top-level scans.

```typescript
interface RepoScanResult {
  index: FileIndex;
  warnings: string[];
}
```

## API Sketch

```typescript
class RepoScanner {
  constructor(config: ScannerConfig);

  scan(options?: ScanOptions): Promise<RepoScanResult>;
  rescan(paths: string[]): Promise<RepoScanResult>;

  getIndex(): FileIndex | null;
  getFile(path: string): FileEntry | undefined;
  getFilesByLanguage(language: string): FileEntry[];
  getDependencySummaries(): DependencySummary[];
  getStats(): RepoStats | null;
  getGitMetadata(): Promise<GitMetadata | null>;
}
```

## Type Sketch

```typescript
interface ScannerConfig {
  rootDir: string;
  include?: string[];
  exclude?: string[];
  ignorePatterns?: string[];
  respectGitignore?: boolean;
  followSymlinks?: boolean;
  maxDepth?: number;
  maxFileSizeBytes?: number;
  hashFiles?: boolean;
  includeGitMetadata?: boolean;
  commitLimit?: number;
}

interface ScanOptions {
  paths?: string[];
  refreshGit?: boolean;
  includeStats?: boolean;
  includeDependencies?: boolean;
}

interface DirectoryEntry {
  path: string;
  fileCount: number;
  directoryCount: number;
}

interface FileStats {
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
}

interface LanguageSummary {
  language: string;
  fileCount: number;
  totalLines: number;
  extensions: string[];
}

interface DependencySummary {
  manifestPath: string;
  ecosystem: 'npm' | 'python' | 'rust' | 'go' | 'unknown';
  packages: DependencyEntry[];
}

interface DependencyEntry {
  name: string;
  version: string;
  kind: 'production' | 'development' | 'peer' | 'optional' | 'unknown';
}

interface GitMetadata {
  rootDir: string;
  branch: string | null;
  head: string | null;
  recentCommits: GitCommit[];
  branches: string[];
  isDirty: boolean;
}

interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  subject: string;
  timestamp: number;
}

interface IgnoreRuleSet {
  patterns: string[];
  sources: Array<'default' | '.gitignore' | 'custom'>;
}
```

## Feature Design

### 1. File System Traversal and Indexing
- Default traversal is recursive from `rootDir`
- Scanner skips common generated/vendor directories by default: `.git`, `node_modules`, `dist`, `build`, `coverage`
- Traversal result is normalized to repo-relative paths for stable downstream usage
- Incremental refresh is modeled as `rescan(paths)` but can fall back to a full scan in the first implementation

### 2. Language Detection
Detection order:
1. Extension lookup
2. Filename special cases (`Dockerfile`, `Makefile`, `.env`, etc.)
3. Shebang inference (`#!/usr/bin/env node`, `python`, `bash`)
4. Fallback to `null`

This is intentionally lightweight. Thread 06 and other parser-heavy threads can layer richer semantic analysis on top.

### 3. Dependency Analysis
Initial manifest support:
- `package.json`
- `requirements.txt`
- `Cargo.toml`
- `go.mod`

The scanner exposes manifest summaries only. It does not attempt to resolve transitive dependency trees in the scaffold stage.

### 4. Git Metadata Extraction
Initial git support includes:
- current branch
- HEAD commit hash
- recent commits (`git log` limited by config)
- local branches
- dirty/clean working tree flag

If git commands fail, the scanner returns `null` metadata and records a warning instead of failing the whole scan.

### 5. Code Statistics
For text files, compute:
- total lines
- blank lines
- comment-like lines (heuristic)
- code lines
- aggregate counts by language and extension

These stats are intentionally approximate and cheap to compute.

### 6. Ignore Patterns
Sources of ignore rules:
1. built-in defaults
2. root `.gitignore`
3. custom `ScannerConfig.ignorePatterns`

Nested `.gitignore` support is noted as future work. The scaffold should keep the ignore API open for that extension.

## Integration Points

### Thread 02: Session Context
- Use file index summaries to build session-aware repo context
- Reuse repo stats for task brief generation

### Thread 03: Patch Engine
- Discover candidate files for edits
- Re-scan touched files after patch application

### Thread 06: Symbol Import Index
- Consume scanner file lists as the source set for parsing
- Reuse language and ignore filtering so indexing stays consistent

### Thread 07: Impact Analyzer
- Consume dependency manifest summaries and file inventory
- Later receive file-change refresh events from scanner

### Thread 08: Context Compressor
- Use language summaries and directory structure for compact repo overviews
- Filter high-value files by language and manifest role

### Thread 13-15: JackClaw Adapters
- Expose repo summaries to JackClaw-compatible memory/collaboration layers
- Attach git metadata to higher-level collaboration or audit flows

## Implementation Notes
- Keep scanner self-contained in `src/core/scanner.ts` for now
- Prefer platform-native Node APIs and shelling out to `git` instead of adding dependencies
- Return structured warnings instead of throwing for recoverable repo-state issues
- Do not make Thread 05 depend on unfinished thread files

## Future Work
- Nested `.gitignore` and `.ignore` support
- File watching and incremental cache invalidation
- Persistent scan cache keyed by repo root and file mtimes
- AST-assisted language/comment detection
- Richer dependency manifest coverage (pnpm, poetry, workspace monorepos)

## Files
- `src/core/scanner.ts` - scanner implementation scaffold and exported types

## Status
Design and TypeScript scaffolding complete. Integration wiring to other modules is intentionally deferred to avoid cross-thread edits.

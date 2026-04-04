/**
 * Types for Thread 04: Build-Test-Loop
 * Core type definitions for build, test, and lint operations
 */

// ============================================================================
// Core Result Types
// ============================================================================

export interface RunResult {
  /** Whether the operation succeeded */
  success: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Stdout/stderr output */
  output: string;
  /** Error messages if any */
  errors: string[];
  /** Optional coverage report */
  coverage?: CoverageReport;
}

export interface CoverageReport {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

// ============================================================================
// Build Types
// ============================================================================

export type BuildTarget = 'es2020' | 'es2022' | 'esnext';

export interface BuildOptions {
  target?: BuildTarget;
  outDir?: string;
  incremental?: boolean;
  sourceMap?: boolean;
}

// ============================================================================
// Test Types
// ============================================================================

export type TestRunnerName = 'vitest' | 'jest' | 'node';

export interface TestRunnerOptions {
  /** Glob pattern for test files */
  pattern?: string;
  /** Watch mode for dev */
  watch?: boolean;
  /** Parallel worker count */
  parallel?: number;
  /** Generate coverage report */
  coverage?: boolean;
  /** Verbose output */
  verbose?: boolean;
  /** Stop on first failure */
  failFast?: boolean;
}

// ============================================================================
// Lint Types
// ============================================================================

export interface LintOptions {
  /** Auto-fix issues */
  fix?: boolean;
  /** Only lint staged files */
  stagedOnly?: boolean;
  /** Run prettier format */
  format?: boolean;
}

// ============================================================================
// Cache Types
// ============================================================================

export interface CacheEntry {
  hash: string;
  mtime: number;
  result: 'pass' | 'fail';
}

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
}

// ============================================================================
// Orchestration Types
// ============================================================================

export interface OrchestratorOptions {
  /** Use incremental builds/tests */
  incremental?: boolean;
  /** Custom cache directory */
  cacheDir?: string;
}

export interface PipelineStage {
  name: string;
  runner: () => Promise<RunResult>;
  dependsOn?: string[];
  skipOnFailure?: boolean;
}

export interface PipelineResult {
  stages: Map<string, RunResult>;
  overallSuccess: boolean;
  totalDurationMs: number;
}

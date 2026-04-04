/**
 * Test Runner - Build/Test/Lint orchestration for JackCode
 * Thread 04: Build-Test-Loop
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, statSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const execAsync = promisify(exec);

// ============================================================================
// Types
// ============================================================================

export interface TestRunnerOptions {
  pattern?: string;
  watch?: boolean;
  parallel?: number;
  coverage?: boolean;
  verbose?: boolean;
  failFast?: boolean;
}

export interface BuildOptions {
  target?: 'es2020' | 'es2022' | 'esnext';
  outDir?: string;
  incremental?: boolean;
  sourceMap?: boolean;
}

export interface LintOptions {
  fix?: boolean;
  stagedOnly?: boolean;
  format?: boolean;
}

export interface RunResult {
  success: boolean;
  durationMs: number;
  output: string;
  errors: string[];
  coverage?: CoverageReport;
}

export interface CoverageReport {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

export interface CacheEntry {
  hash: string;
  mtime: number;
  result: 'pass' | 'fail';
}

// ============================================================================
// Cache Manager
// ============================================================================

export class CacheManager {
  private cacheDir: string;

  constructor(cacheDir = '.jackcode/cache') {
    this.cacheDir = resolve(cacheDir);
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  getCacheKey(filePath: string): string {
    const stats = statSync(filePath);
    const content = readFileSync(filePath, 'utf-8');
    return `${filePath}:${stats.mtime.getTime()}:${this.hash(content)}`;
  }

  get(filePath: string): CacheEntry | null {
    const key = this.getCacheKey(filePath);
    const cacheFile = join(this.cacheDir, `${this.hash(key)}.json`);
    
    if (!existsSync(cacheFile)) return null;
    
    try {
      return JSON.parse(readFileSync(cacheFile, 'utf-8')) as CacheEntry;
    } catch {
      return null;
    }
  }

  set(filePath: string, result: 'pass' | 'fail'): void {
    const key = this.getCacheKey(filePath);
    const cacheFile = join(this.cacheDir, `${this.hash(key)}.json`);
    const entry: CacheEntry = {
      hash: key,
      mtime: Date.now(),
      result
    };
    writeFileSync(cacheFile, JSON.stringify(entry));
  }

  private hash(str: string): string {
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16);
  }
}

// ============================================================================
// Build Runner
// ============================================================================

export class BuildRunner {
  private cache: CacheManager;

  constructor(cacheDir?: string) {
    this.cache = new CacheManager(cacheDir);
  }

  async compile(options: BuildOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const { target = 'es2022', outDir = 'dist', incremental = true } = options;
    
    const args = [
      'tsc',
      '--target', target,
      '--outDir', outDir,
      incremental ? '--incremental' : '',
      '--noEmitOnError'
    ].filter(Boolean);

    try {
      const { stdout, stderr } = await execAsync(args.join(' '));
      return {
        success: true,
        durationMs: Date.now() - start,
        output: stdout || 'Build completed successfully',
        errors: stderr ? [stderr] : []
      };
    } catch (error) {
      return {
        success: false,
        durationMs: Date.now() - start,
        output: '',
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  async clean(outDir = 'dist'): Promise<void> {
    await execAsync(`rm -rf ${outDir}`);
  }
}

// ============================================================================
// Test Runner
// ============================================================================

export class TestRunner {
  private cache: CacheManager;

  constructor(cacheDir?: string) {
    this.cache = new CacheManager(cacheDir);
  }

  async run(options: TestRunnerOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const { 
      pattern = 'src/**/*.test.ts', 
      watch = false, 
      parallel = 4,
      coverage = false,
      failFast = false
    } = options;

    // Detect test runner
    const runner = await this.detectTestRunner();
    const args = this.buildTestArgs(runner, { pattern, watch, parallel, coverage, failFast });

    try {
      const { stdout, stderr } = await execAsync(args, { 
        env: { ...process.env, NODE_ENV: 'test' }
      });
      
      return {
        success: true,
        durationMs: Date.now() - start,
        output: stdout,
        errors: stderr ? [stderr] : [],
        coverage: coverage ? this.parseCoverage(stdout) : undefined
      };
    } catch (error) {
      return {
        success: false,
        durationMs: Date.now() - start,
        output: '',
        errors: [error instanceof Error ? error.message : String(error)]
      };
    }
  }

  private async detectTestRunner(): Promise<'vitest' | 'jest' | 'node'> {
    try {
      await execAsync('which vitest');
      return 'vitest';
    } catch {
      try {
        await execAsync('which jest');
        return 'jest';
      } catch {
        return 'node';
      }
    }
  }

  private buildTestArgs(
    runner: 'vitest' | 'jest' | 'node',
    options: Required<TestRunnerOptions>
  ): string {
    const { pattern, watch, parallel, coverage, failFast } = options;
    
    switch (runner) {
      case 'vitest':
        return [
          'vitest run',
          pattern,
          watch ? '--watch' : '',
          coverage ? '--coverage' : '',
          `--pool-threads=${parallel}`,
          failFast ? '--bail=1' : ''
        ].filter(Boolean).join(' ');
        
      case 'jest':
        return [
          'jest',
          pattern,
          watch ? '--watch' : '',
          coverage ? '--coverage' : '',
          `--maxWorkers=${parallel}`,
          failFast ? '--bail' : ''
        ].filter(Boolean).join(' ');
        
      case 'node':
        return `node --test ${pattern}`;
    }
  }

  private parseCoverage(output: string): CoverageReport | undefined {
    // Simple regex parsers for common coverage formats
    const lines = output.match(/Lines\s*:\s*(\d+\.?\d*)%/)?.[1];
    const funcs = output.match(/Functions\s*:\s*(\d+\.?\d*)%/)?.[1];
    const branches = output.match(/Branches\s*:\s*(\d+\.?\d*)%/)?.[1];
    
    if (lines) {
      return {
        lines: parseFloat(lines),
        functions: parseFloat(funcs || '0'),
        branches: parseFloat(branches || '0'),
        statements: parseFloat(lines) // Fallback
      };
    }
    return undefined;
  }
}

// ============================================================================
// Linter
// ============================================================================

export class Linter {
  async lint(options: LintOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const { fix = false, stagedOnly = false, format = true } = options;

    const errors: string[] = [];
    let output = '';

    // ESLint
    try {
      const eslintArgs = [
        'eslint',
        stagedOnly ? '--changed --staged' : 'src/',
        fix ? '--fix' : '',
        '--format stylish'
      ].filter(Boolean);
      
      const { stdout } = await execAsync(eslintArgs.join(' '));
      output += stdout;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }

    // Prettier (format check)
    if (format) {
      try {
        const prettierArgs = [
          'prettier',
          fix ? '--write' : '--check',
          stagedOnly ? '--staged' : 'src/**/*.ts'
        ].filter(Boolean);
        
        const { stdout } = await execAsync(prettierArgs.join(' '));
        output += stdout;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }

    return {
      success: errors.length === 0,
      durationMs: Date.now() - start,
      output,
      errors
    };
  }
}

// ============================================================================
// Build Test Loop Orchestrator
// ============================================================================

export interface OrchestratorOptions {
  incremental?: boolean;
  cacheDir?: string;
}

export class BuildTestLoopOrchestrator {
  private buildRunner: BuildRunner;
  private testRunner: TestRunner;
  private linter: Linter;

  constructor(options: OrchestratorOptions = {}) {
    const cacheDir = options.cacheDir;
    this.buildRunner = new BuildRunner(cacheDir);
    this.testRunner = new TestRunner(cacheDir);
    this.linter = new Linter();
  }

  async run(options: OrchestratorOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const results: RunResult[] = [];

    // Step 1: Build
    console.log('🔨 Building...');
    const buildResult = await this.buildRunner.compile({ incremental: options.incremental });
    results.push(buildResult);
    
    if (!buildResult.success) {
      return {
        success: false,
        durationMs: Date.now() - start,
        output: buildResult.output,
        errors: ['Build failed', ...buildResult.errors]
      };
    }

    // Step 2: Lint
    console.log('🧹 Linting...');
    const lintResult = await this.linter.lint({ fix: false, stagedOnly: false });
    results.push(lintResult);

    // Step 3: Test
    console.log('🧪 Testing...');
    const testResult = await this.testRunner.run({ 
      pattern: 'src/**/*.test.ts',
      parallel: 4,
      failFast: true
    });
    results.push(testResult);

    const success = results.every(r => r.success);
    const allErrors = results.flatMap(r => r.errors);

    return {
      success,
      durationMs: Date.now() - start,
      output: results.map(r => r.output).join('\n---\n'),
      errors: allErrors
    };
  }

  async build(options?: BuildOptions): Promise<RunResult> {
    return this.buildRunner.compile(options);
  }

  async test(options?: TestRunnerOptions): Promise<RunResult> {
    return this.testRunner.run(options);
  }

  async lint(options?: LintOptions): Promise<RunResult> {
    return this.linter.lint(options);
  }

  async clean(): Promise<void> {
    await this.buildRunner.clean();
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

export async function main(args: string[]): Promise<void> {
  const command = args[0] || 'run';
  const orchestrator = new BuildTestLoopOrchestrator({ incremental: true });

  let result: RunResult;

  switch (command) {
    case 'build':
      result = await orchestrator.build();
      break;
    case 'test':
      result = await orchestrator.test();
      break;
    case 'lint':
      result = await orchestrator.lint({ fix: args.includes('--fix') });
      break;
    case 'run':
    default:
      result = await orchestrator.run({ incremental: !args.includes('--full') });
  }

  if (result.success) {
    console.log('✅ Success');
    process.exit(0);
  } else {
    console.error('❌ Failed');
    result.errors.forEach(e => console.error(e));
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
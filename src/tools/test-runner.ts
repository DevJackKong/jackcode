/**
 * Test Runner - Build/Test/Lint orchestration for JackCode
 * Thread 04: Build-Test-Loop
 */

import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

type CommandSpec = {
  command: string;
  args: string[];
};

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
    return `${filePath}:${stats.mtimeMs}:${this.hash(content)}`;
  }

  get(filePath: string): CacheEntry | null {
    const key = this.getCacheKey(filePath);
    const cacheFile = join(this.cacheDir, `${this.hash(key)}.json`);

    if (!existsSync(cacheFile)) {
      return null;
    }

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
      result,
    };
    writeFileSync(cacheFile, JSON.stringify(entry));
  }

  private hash(str: string): string {
    let hashValue = 0;
    for (let i = 0; i < str.length; i++) {
      hashValue = ((hashValue << 5) - hashValue + str.charCodeAt(i)) | 0;
    }
    return Math.abs(hashValue).toString(16);
  }
}

async function commandExists(command: string): Promise<boolean> {
  try {
    await execFileAsync('which', [command]);
    return true;
  } catch {
    return false;
  }
}

function combineOutput(stdout = '', stderr = ''): string {
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class BuildRunner {
  constructor(cacheDir?: string) {
    void cacheDir;
  }

  async compile(options: BuildOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const { target = 'es2022', outDir = 'dist', incremental = true, sourceMap = false } = options;

    const command = await this.resolveTypeScriptCommand();
    if (!command) {
      return {
        success: false,
        durationMs: Date.now() - start,
        output: '',
        errors: ['TypeScript compiler not found. Install project dependencies or add tsc to PATH.'],
      };
    }

    const args = [
      '--target', target,
      '--outDir', outDir,
      '--noEmitOnError',
      ...(incremental ? ['--incremental'] : []),
      ...(sourceMap ? ['--sourceMap'] : []),
    ];

    try {
      const { stdout, stderr } = await execFileAsync(command.command, [...command.args, ...args], {
        env: { ...process.env },
      });

      return {
        success: true,
        durationMs: Date.now() - start,
        output: combineOutput(stdout, stderr) || 'Build completed successfully',
        errors: [],
      };
    } catch (error: unknown) {
      const errorWithStreams = error as { stdout?: string; stderr?: string };
      return {
        success: false,
        durationMs: Date.now() - start,
        output: combineOutput(errorWithStreams.stdout, errorWithStreams.stderr),
        errors: [normalizeError(error)],
      };
    }
  }

  async clean(outDir = 'dist'): Promise<void> {
    rmSync(resolve(outDir), { recursive: true, force: true });
  }

  private async resolveTypeScriptCommand(): Promise<CommandSpec | null> {
    if (await commandExists('tsc')) {
      return { command: 'tsc', args: [] };
    }
    if (await commandExists('npx')) {
      return { command: 'npx', args: ['--no-install', 'tsc'] };
    }
    return null;
  }
}

export class TestRunner {
  constructor(cacheDir?: string) {
    void cacheDir;
  }

  async run(options: TestRunnerOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const normalizedOptions: Required<TestRunnerOptions> = {
      pattern: options.pattern ?? 'src/**/*.test.ts',
      watch: options.watch ?? false,
      parallel: Math.max(1, options.parallel ?? 4),
      coverage: options.coverage ?? false,
      verbose: options.verbose ?? false,
      failFast: options.failFast ?? false,
    };

    const runner = await this.detectTestRunner();
    const command = this.buildTestCommand(runner, normalizedOptions);

    try {
      const { stdout, stderr } = await execFileAsync(command.command, command.args, {
        env: { ...process.env, NODE_ENV: 'test' },
      });

      return {
        success: true,
        durationMs: Date.now() - start,
        output: combineOutput(stdout, stderr),
        errors: [],
        coverage: normalizedOptions.coverage ? this.parseCoverage(`${stdout}\n${stderr}`) : undefined,
      };
    } catch (error: unknown) {
      const errorWithStreams = error as { stdout?: string; stderr?: string };
      return {
        success: false,
        durationMs: Date.now() - start,
        output: combineOutput(errorWithStreams.stdout, errorWithStreams.stderr),
        errors: [normalizeError(error)],
      };
    }
  }

  private async detectTestRunner(): Promise<'vitest' | 'jest' | 'node'> {
    if (await commandExists('vitest')) {
      return 'vitest';
    }
    if (await commandExists('jest')) {
      return 'jest';
    }
    return 'node';
  }

  private buildTestCommand(
    runner: 'vitest' | 'jest' | 'node',
    options: Required<TestRunnerOptions>
  ): CommandSpec {
    const { pattern, watch, parallel, coverage, verbose, failFast } = options;

    switch (runner) {
      case 'vitest':
        return {
          command: 'vitest',
          args: [
            watch ? 'watch' : 'run',
            pattern,
            ...(coverage ? ['--coverage'] : []),
            `--pool=threads`,
            `--poolOptions.threads.maxThreads=${parallel}`,
            ...(verbose ? ['--reporter=verbose'] : []),
            ...(failFast ? ['--bail=1'] : []),
          ],
        };
      case 'jest':
        return {
          command: 'jest',
          args: [
            pattern,
            ...(watch ? ['--watch'] : []),
            ...(coverage ? ['--coverage'] : []),
            `--maxWorkers=${parallel}`,
            ...(verbose ? ['--verbose'] : []),
            ...(failFast ? ['--bail'] : []),
          ],
        };
      case 'node':
        return {
          command: 'node',
          args: [
            '--test',
            ...(watch ? ['--watch'] : []),
            pattern,
          ],
        };
    }
  }

  private parseCoverage(output: string): CoverageReport | undefined {
    const lines = output.match(/Lines\s*:\s*(\d+\.?\d*)%/)?.[1];
    const functions = output.match(/Functions\s*:\s*(\d+\.?\d*)%/)?.[1];
    const branches = output.match(/Branches\s*:\s*(\d+\.?\d*)%/)?.[1];
    const statements = output.match(/Statements\s*:\s*(\d+\.?\d*)%/)?.[1];

    if (!lines) {
      return undefined;
    }

    return {
      lines: parseFloat(lines),
      functions: parseFloat(functions ?? lines),
      branches: parseFloat(branches ?? lines),
      statements: parseFloat(statements ?? lines),
    };
  }
}

export class Linter {
  async lint(options: LintOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const { fix = false, stagedOnly = false, format = true } = options;

    const errors: string[] = [];
    const outputs: string[] = [];

    if (await commandExists('eslint')) {
      try {
        const args = [
          stagedOnly ? '--stdin' : 'src/',
          ...(fix ? ['--fix'] : []),
          '--format',
          'stylish',
        ];
        const { stdout, stderr } = await execFileAsync('eslint', args);
        outputs.push(combineOutput(stdout, stderr));
      } catch (error) {
        errors.push(normalizeError(error));
      }
    } else {
      errors.push('eslint not found in PATH');
    }

    if (format) {
      if (await commandExists('prettier')) {
        try {
          const args = [fix ? '--write' : '--check', stagedOnly ? '.' : 'src/**/*.ts'];
          const { stdout, stderr } = await execFileAsync('prettier', args);
          outputs.push(combineOutput(stdout, stderr));
        } catch (error) {
          errors.push(normalizeError(error));
        }
      } else {
        errors.push('prettier not found in PATH');
      }
    }

    return {
      success: errors.length === 0,
      durationMs: Date.now() - start,
      output: outputs.filter(Boolean).join('\n'),
      errors,
    };
  }
}

export interface OrchestratorOptions {
  incremental?: boolean;
  cacheDir?: string;
}

export class BuildTestLoopOrchestrator {
  private buildRunner: BuildRunner;
  private testRunner: TestRunner;
  private linter: Linter;

  constructor(options: OrchestratorOptions = {}) {
    this.buildRunner = new BuildRunner(options.cacheDir);
    this.testRunner = new TestRunner(options.cacheDir);
    this.linter = new Linter();
  }

  async run(options: OrchestratorOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const results: RunResult[] = [];

    const buildResult = await this.buildRunner.compile({ incremental: options.incremental });
    results.push(buildResult);
    if (!buildResult.success) {
      return {
        success: false,
        durationMs: Date.now() - start,
        output: buildResult.output,
        errors: ['Build failed', ...buildResult.errors],
      };
    }

    const lintResult = await this.linter.lint({ fix: false, stagedOnly: false });
    results.push(lintResult);

    const testResult = await this.testRunner.run({
      pattern: 'src/**/*.test.ts',
      parallel: 4,
      failFast: true,
    });
    results.push(testResult);

    return {
      success: results.every((result) => result.success),
      durationMs: Date.now() - start,
      output: results.map((result) => result.output).filter(Boolean).join('\n---\n'),
      errors: results.flatMap((result) => result.errors),
      coverage: testResult.coverage,
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
      break;
  }

  if (result.success) {
    console.log('✅ Success');
    process.exit(0);
  }

  console.error('❌ Failed');
  for (const error of result.errors) {
    console.error(error);
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

/**
 * Test Runner - Build/Test/Lint orchestration for JackCode
 * Thread 04: Build-Test-Loop
 */

import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import type { SessionManager } from '../core/session.ts';
import type { RuntimeStateMachine, TaskContext } from '../core/runtime.ts';
import type { RepoScanner } from '../core/scanner.ts';
import type { ImpactAnalyzer } from '../repo/impact-analyzer.ts';
import type { Patch, PatchPlan } from '../types/patch.ts';
import type { ChangeDescriptor } from '../types/impact-analyzer.ts';

const execFileAsync = promisify(execFile);

export type CommandSpec = {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string | undefined>;
  label?: string;
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
  command?: CommandSpec;
  classification?: FailureClassification;
  meta?: Record<string, unknown>;
}

export interface CoverageReport {
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

export interface CoverageThresholds {
  lines?: number;
  functions?: number;
  branches?: number;
  statements?: number;
}

export interface CoverageTrendEntry {
  timestamp: number;
  lines: number;
  functions: number;
  branches: number;
  statements: number;
}

export interface TestCompletionEvent {
  result: RunResult;
  selectedTests: string[];
  changedFiles?: string[];
  trigger: 'manual' | 'patch' | 'affected' | 'loop';
}

export interface TestRunnerIntegrations {
  runtime?: RuntimeStateMachine;
  session?: SessionManager;
  scanner?: RepoScanner;
  impactAnalyzer?: ImpactAnalyzer;
  sessionId?: string;
  taskId?: string;
}

export interface CacheEntry {
  hash: string;
  mtime: number;
  result: 'pass' | 'fail';
}

export type PackageManager = 'npm' | 'yarn' | 'pnpm';
export type TestRunnerName = 'vitest' | 'jest' | 'mocha' | 'node';
export type FailureClassification =
  | 'none'
  | 'build'
  | 'test'
  | 'lint'
  | 'coverage'
  | 'environment'
  | 'configuration'
  | 'unknown';

export interface LoopStageResult {
  stage: 'pre' | 'build' | 'lint' | 'test' | 'post';
  result: RunResult;
}

export interface LoopRunResult extends RunResult {
  stages: LoopStageResult[];
  retries: number;
  prePatchPassed: boolean;
  postPatchPassed: boolean;
}

export interface OrchestratorOptions {
  incremental?: boolean;
  cacheDir?: string;
  rootDir?: string;
  retryAttempts?: number;
  retryDelayMs?: number;
  coverageThresholds?: CoverageThresholds;
  integrations?: TestRunnerIntegrations;
}

export interface ExecResult {
  stdout?: string;
  stderr?: string;
}

export type CommandExecutor = (spec: CommandSpec) => Promise<ExecResult>;

interface PackageJsonShape {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 150;

export function combineOutput(stdout = '', stderr = ''): string {
  return [stdout, stderr].filter(Boolean).join('\n').trim();
}

export function normalizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function defaultExecutor(spec: CommandSpec): Promise<ExecResult> {
  const { stdout, stderr } = await execFileAsync(spec.command, spec.args, {
    cwd: spec.cwd,
    env: { ...process.env, ...spec.env },
  });
  return { stdout, stderr };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) {
    return null;
  }

  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export function findUp(startDir: string, candidates: string[]): string | null {
  let current = resolve(startDir);

  while (true) {
    for (const candidate of candidates) {
      const file = join(current, candidate);
      if (existsSync(file)) {
        return file;
      }
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export function classifyFailure(output: string, errors: string[]): FailureClassification {
  const text = `${output}\n${errors.join('\n')}`.toLowerCase();

  if (!text.trim()) return 'none';
  if (
    text.includes('not found') ||
    text.includes('enoent') ||
    text.includes('command failed') ||
    text.includes('eacces')
  ) return 'environment';
  if (text.includes('eslint') || text.includes('prettier') || text.includes('lint')) return 'lint';
  if (text.includes('coverage') || text.includes('threshold')) return 'coverage';
  if (
    text.includes('vitest') ||
    text.includes('jest') ||
    text.includes('mocha') ||
    text.includes('failing test') ||
    text.includes('tests failed') ||
    text.includes('assert')
  ) return 'test';
  if (
    text.includes('tsc') ||
    text.includes('typescript') ||
    text.includes('compile') ||
    text.includes('build failed') ||
    text.includes('noemitonerror')
  ) return 'build';
  if (
    text.includes('tsconfig') ||
    text.includes('package.json') ||
    text.includes('configuration') ||
    text.includes('unsupported')
  ) return 'configuration';
  return 'unknown';
}

export function parseCoverageFromText(output: string): CoverageReport | undefined {
  const normalized = output.replace(/\r/g, '');
  const lines = normalized.match(/Lines\s*[:|]\s*(\d+(?:\.\d+)?)%/i)?.[1];
  const functions = normalized.match(/Functions\s*[:|]\s*(\d+(?:\.\d+)?)%/i)?.[1];
  const branches = normalized.match(/Branches\s*[:|]\s*(\d+(?:\.\d+)?)%/i)?.[1];
  const statements = normalized.match(/Statements\s*[:|]\s*(\d+(?:\.\d+)?)%/i)?.[1];

  if (!lines && !functions && !branches && !statements) {
    return undefined;
  }

  const fallback = parseFloat(lines ?? functions ?? branches ?? statements ?? '0');
  return {
    lines: parseFloat(lines ?? String(fallback)),
    functions: parseFloat(functions ?? String(fallback)),
    branches: parseFloat(branches ?? String(fallback)),
    statements: parseFloat(statements ?? String(fallback)),
  };
}

export function checkCoverageThresholds(
  coverage: CoverageReport,
  thresholds: CoverageThresholds = {}
): string[] {
  const failures: string[] = [];
  const pairs: Array<keyof CoverageReport> = ['lines', 'functions', 'branches', 'statements'];

  for (const key of pairs) {
    const threshold = thresholds[key];
    if (typeof threshold === 'number' && coverage[key] < threshold) {
      failures.push(`Coverage threshold failed for ${key}: ${coverage[key]}% < ${threshold}%`);
    }
  }

  return failures;
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

export class ProjectEnvironment {
  readonly rootDir: string;
  readonly cacheDir: string;
  private packageJsonCache?: PackageJsonShape | null;

  constructor(rootDir = process.cwd(), cacheDir = '.jackcode/cache') {
    this.rootDir = resolve(rootDir);
    this.cacheDir = resolve(this.rootDir, cacheDir);
    mkdirSync(this.cacheDir, { recursive: true });
  }

  getPackageJsonPath(): string | null {
    return findUp(this.rootDir, ['package.json']);
  }

  getPackageJson(): PackageJsonShape | null {
    if (this.packageJsonCache !== undefined) {
      return this.packageJsonCache;
    }

    const file = this.getPackageJsonPath();
    this.packageJsonCache = file ? readJsonFile<PackageJsonShape>(file) : null;
    return this.packageJsonCache;
  }

  getScripts(): Record<string, string> {
    return this.getPackageJson()?.scripts ?? {};
  }

  getDependencies(): Record<string, string> {
    const pkg = this.getPackageJson();
    return {
      ...(pkg?.dependencies ?? {}),
      ...(pkg?.devDependencies ?? {}),
    };
  }

  detectPackageManager(): PackageManager {
    if (existsSync(join(this.rootDir, 'pnpm-lock.yaml'))) return 'pnpm';
    if (existsSync(join(this.rootDir, 'yarn.lock'))) return 'yarn';
    return 'npm';
  }

  getPackageManagerCommand(): CommandSpec {
    const pm = this.detectPackageManager();
    return { command: pm, args: [], cwd: this.rootDir };
  }

  hasDependency(name: string): boolean {
    return Boolean(this.getDependencies()[name]);
  }

  hasScript(name: string): boolean {
    return Boolean(this.getScripts()[name]);
  }

  discoverBuildConfig(): {
    tsconfigPath?: string;
    packageManager: PackageManager;
    buildScript?: string;
    testScript?: string;
    lintScript?: string;
    prettierConfig?: string;
    eslintConfig?: string;
  } {
    return {
      tsconfigPath: findUp(this.rootDir, ['tsconfig.json', 'tsconfig.build.json']) ?? undefined,
      packageManager: this.detectPackageManager(),
      buildScript: this.hasScript('build') ? this.getScripts().build : undefined,
      testScript: this.hasScript('test') ? this.getScripts().test : undefined,
      lintScript: this.hasScript('lint') ? this.getScripts().lint : undefined,
      prettierConfig:
        findUp(this.rootDir, ['.prettierrc', '.prettierrc.json', 'prettier.config.js']) ?? undefined,
      eslintConfig:
        findUp(this.rootDir, ['eslint.config.js', '.eslintrc', '.eslintrc.js', '.eslintrc.json']) ?? undefined,
    };
  }

  resolveLocalBin(name: string): string | null {
    const suffix = process.platform === 'win32' ? '.cmd' : '';
    const bin = join(this.rootDir, 'node_modules', '.bin', `${name}${suffix}`);
    return existsSync(bin) ? bin : null;
  }

  coverageSummaryPath(): string {
    return join(this.rootDir, 'coverage', 'coverage-summary.json');
  }

  coverageTrendPath(): string {
    return join(this.cacheDir, 'coverage-history.json');
  }
}

export class CoverageTracker {
  private readonly environment: ProjectEnvironment;

  constructor(environment: ProjectEnvironment) {
    this.environment = environment;
  }

  parseCoverage(output: string): CoverageReport | undefined {
    const summary = readJsonFile<{
      total?: Record<string, { pct?: number }>;
    }>(this.environment.coverageSummaryPath());

    if (summary?.total) {
      const total = summary.total;
      return {
        lines: total.lines?.pct ?? 0,
        functions: total.functions?.pct ?? 0,
        branches: total.branches?.pct ?? 0,
        statements: total.statements?.pct ?? 0,
      };
    }

    return parseCoverageFromText(output);
  }

  record(report: CoverageReport): CoverageTrendEntry[] {
    const file = this.environment.coverageTrendPath();
    const history = readJsonFile<CoverageTrendEntry[]>(file) ?? [];
    const next = [
      ...history,
      {
        timestamp: Date.now(),
        ...report,
      },
    ].slice(-50);
    writeFileSync(file, JSON.stringify(next, null, 2));
    return next;
  }

  latestTrend(): CoverageTrendEntry | undefined {
    const history = readJsonFile<CoverageTrendEntry[]>(this.environment.coverageTrendPath()) ?? [];
    return history[history.length - 1];
  }
}

export class BuildRunner {
  private readonly environment: ProjectEnvironment;
  private readonly executor: CommandExecutor;

  constructor(
    environment = new ProjectEnvironment(),
    executor: CommandExecutor = defaultExecutor
  ) {
    this.environment = environment;
    this.executor = executor;
  }

  async compile(options: BuildOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const command = this.createBuildCommand(options);

    try {
      const { stdout, stderr } = await this.executor(command);
      return {
        success: true,
        durationMs: Date.now() - start,
        output: combineOutput(stdout, stderr) || 'Build completed successfully',
        errors: [],
        command,
        classification: 'none',
        meta: {
          incremental: options.incremental ?? true,
          packageManager: this.environment.detectPackageManager(),
          config: this.environment.discoverBuildConfig(),
        },
      };
    } catch (error: unknown) {
      const details = error as ExecResult;
      const output = combineOutput(details.stdout, details.stderr);
      return {
        success: false,
        durationMs: Date.now() - start,
        output,
        errors: [normalizeError(error)],
        command,
        classification: classifyFailure(output, [normalizeError(error)]),
      };
    }
  }

  createBuildCommand(options: BuildOptions = {}): CommandSpec {
    const { target = 'es2022', outDir = 'dist', incremental = true, sourceMap = false } = options;
    const config = this.environment.discoverBuildConfig();

    if (config.buildScript) {
      const pm = this.environment.detectPackageManager();
      return {
        command: pm,
        args: ['run', 'build'],
        cwd: this.environment.rootDir,
        label: 'package-build',
      };
    }

    const localTsc = this.environment.resolveLocalBin('tsc');
    if (localTsc || config.tsconfigPath) {
      return {
        command: localTsc ?? 'npx',
        args: localTsc
          ? [
              '--project',
              config.tsconfigPath ?? 'tsconfig.json',
              '--target',
              target,
              '--outDir',
              outDir,
              '--noEmitOnError',
              ...(incremental ? ['--incremental'] : []),
              ...(sourceMap ? ['--sourceMap'] : []),
            ]
          : [
              '--no-install',
              'tsc',
              '--project',
              config.tsconfigPath ?? 'tsconfig.json',
              '--target',
              target,
              '--outDir',
              outDir,
              '--noEmitOnError',
              ...(incremental ? ['--incremental'] : []),
              ...(sourceMap ? ['--sourceMap'] : []),
            ],
        cwd: this.environment.rootDir,
        label: 'tsc-build',
      };
    }

    return {
      command: 'node',
      args: ['-e', 'console.error("No build configuration found"); process.exit(1)'],
      cwd: this.environment.rootDir,
      label: 'missing-build-config',
    };
  }

  async clean(outDir = 'dist'): Promise<void> {
    rmSync(resolve(this.environment.rootDir, outDir), { recursive: true, force: true });
  }
}

export class TestRunner {
  private readonly environment: ProjectEnvironment;
  private readonly executor: CommandExecutor;
  private readonly coverageTracker: CoverageTracker;
  private readonly integrations: TestRunnerIntegrations;
  private readonly completionCallbacks = new Set<(event: TestCompletionEvent) => void>();

  constructor(
    environment = new ProjectEnvironment(),
    executor: CommandExecutor = defaultExecutor,
    integrations: TestRunnerIntegrations = {}
  ) {
    this.environment = environment;
    this.executor = executor;
    this.coverageTracker = new CoverageTracker(environment);
    this.integrations = integrations;
  }

  onComplete(callback: (event: TestCompletionEvent) => void): () => void {
    this.completionCallbacks.add(callback);
    return () => this.completionCallbacks.delete(callback);
  }

  detectTestRunner(): TestRunnerName {
    const deps = this.environment.getDependencies();
    const scripts = this.environment.getScripts();
    const files = safeReadDir(this.environment.rootDir);

    if (deps.vitest || files.some((file) => /^vitest\.config\./.test(file))) return 'vitest';
    if (deps.jest || deps['ts-jest'] || files.some((file) => /^jest\.config\./.test(file))) return 'jest';
    if (deps.mocha || files.includes('.mocharc.json') || files.includes('.mocharc.js')) return 'mocha';
    if (scripts.test?.includes('vitest')) return 'vitest';
    if (scripts.test?.includes('jest')) return 'jest';
    if (scripts.test?.includes('mocha')) return 'mocha';
    return 'node';
  }

  createTestCommand(options: Required<TestRunnerOptions>): CommandSpec {
    const runner = this.detectTestRunner();
    const { pattern, watch, parallel, coverage, verbose, failFast } = options;
    const localRunner = this.environment.resolveLocalBin(runner === 'node' ? 'node' : runner);

    switch (runner) {
      case 'vitest':
        return {
          command: localRunner ?? 'npx',
          args: localRunner
            ? [
                watch ? 'watch' : 'run',
                pattern,
                ...(coverage ? ['--coverage'] : []),
                `--pool=threads`,
                `--poolOptions.threads.maxThreads=${parallel}`,
                ...(verbose ? ['--reporter=verbose'] : []),
                ...(failFast ? ['--bail=1'] : []),
              ]
            : [
                '--no-install',
                'vitest',
                watch ? 'watch' : 'run',
                pattern,
                ...(coverage ? ['--coverage'] : []),
                `--pool=threads`,
                `--poolOptions.threads.maxThreads=${parallel}`,
                ...(verbose ? ['--reporter=verbose'] : []),
                ...(failFast ? ['--bail=1'] : []),
              ],
          cwd: this.environment.rootDir,
          env: { NODE_ENV: 'test' },
          label: 'vitest',
        };
      case 'jest':
        return {
          command: localRunner ?? 'npx',
          args: localRunner
            ? [
                pattern,
                ...(watch ? ['--watch'] : []),
                ...(coverage ? ['--coverage'] : []),
                `--maxWorkers=${parallel}`,
                ...(verbose ? ['--verbose'] : []),
                ...(failFast ? ['--bail'] : []),
              ]
            : [
                '--no-install',
                'jest',
                pattern,
                ...(watch ? ['--watch'] : []),
                ...(coverage ? ['--coverage'] : []),
                `--maxWorkers=${parallel}`,
                ...(verbose ? ['--verbose'] : []),
                ...(failFast ? ['--bail'] : []),
              ],
          cwd: this.environment.rootDir,
          env: { NODE_ENV: 'test' },
          label: 'jest',
        };
      case 'mocha':
        return {
          command: localRunner ?? 'npx',
          args: localRunner
            ? [
                pattern,
                ...(watch ? ['--watch'] : []),
                ...(parallel > 1 ? ['--parallel', `--jobs=${parallel}`] : []),
                ...(verbose ? ['--reporter', 'spec'] : []),
                ...(failFast ? ['--bail'] : []),
              ]
            : [
                '--no-install',
                'mocha',
                pattern,
                ...(watch ? ['--watch'] : []),
                ...(parallel > 1 ? ['--parallel', `--jobs=${parallel}`] : []),
                ...(verbose ? ['--reporter', 'spec'] : []),
                ...(failFast ? ['--bail'] : []),
              ],
          cwd: this.environment.rootDir,
          env: { NODE_ENV: 'test' },
          label: 'mocha',
        };
      case 'node':
      default:
        return {
          command: 'node',
          args: ['--test', ...(watch ? ['--watch'] : []), pattern],
          cwd: this.environment.rootDir,
          env: { NODE_ENV: 'test' },
          label: 'node-test',
        };
    }
  }

  async run(
    options: TestRunnerOptions = {},
    thresholds?: CoverageThresholds
  ): Promise<RunResult> {
    return this.runWithSelection({
      options,
      thresholds,
      selectedTests: this.resolveSelectedTests(options.pattern),
      trigger: 'manual',
    });
  }

  async runAffectedTests(changedFiles: string[], thresholds?: CoverageThresholds): Promise<RunResult> {
    const selectedTests = await this.selectAffectedTests(changedFiles);
    return this.runWithSelection({
      options: {
        pattern: selectedTests.length > 0 ? selectedTests.join(' ') : 'src/**/*.test.ts',
        coverage: true,
        failFast: true,
        parallel: 4,
      },
      thresholds,
      selectedTests,
      changedFiles,
      trigger: 'affected',
    });
  }

  async runForPatch(patch: Patch | PatchPlan, thresholds?: CoverageThresholds): Promise<RunResult> {
    const changedFiles = 'patches' in patch
      ? patch.patches.map((entry) => entry.targetPath)
      : [patch.targetPath];

    return this.runWithSelection({
      options: {
        pattern: undefined,
        coverage: true,
        failFast: true,
        parallel: 4,
      },
      thresholds,
      selectedTests: await this.selectAffectedTests(changedFiles),
      changedFiles,
      trigger: 'patch',
    });
  }

  private async runWithSelection(params: {
    options: TestRunnerOptions;
    thresholds?: CoverageThresholds;
    selectedTests: string[];
    changedFiles?: string[];
    trigger: TestCompletionEvent['trigger'];
  }): Promise<RunResult> {
    const start = Date.now();
    const normalizedOptions: Required<TestRunnerOptions> = {
      pattern: params.options.pattern ?? (params.selectedTests.length > 0 ? params.selectedTests.join(' ') : 'src/**/*.test.ts'),
      watch: params.options.watch ?? false,
      parallel: Math.max(1, params.options.parallel ?? 4),
      coverage: params.options.coverage ?? false,
      verbose: params.options.verbose ?? false,
      failFast: params.options.failFast ?? false,
    };

    const command = this.createTestCommand(normalizedOptions);
    this.markRuntimeBusy(params.trigger, params.changedFiles);

    try {
      const { stdout, stderr } = await this.executor(command);
      const output = combineOutput(stdout, stderr);
      const coverage = normalizedOptions.coverage ? this.coverageTracker.parseCoverage(output) : undefined;
      const thresholdErrors = coverage ? checkCoverageThresholds(coverage, params.thresholds) : [];

      if (coverage) {
        this.coverageTracker.record(coverage);
      }

      const result: RunResult = {
        success: thresholdErrors.length === 0,
        durationMs: Date.now() - start,
        output,
        errors: thresholdErrors,
        coverage,
        command,
        classification: thresholdErrors.length > 0 ? 'coverage' : 'none',
        meta: {
          runner: this.detectTestRunner(),
          latestTrend: this.coverageTracker.latestTrend(),
          selectedTests: params.selectedTests,
          changedFiles: params.changedFiles,
        },
      };
      this.completeRun(result, params.selectedTests, params.changedFiles, params.trigger);
      return result;
    } catch (error: unknown) {
      const details = error as ExecResult;
      const output = combineOutput(details.stdout, details.stderr);
      const coverage = normalizedOptions.coverage ? this.coverageTracker.parseCoverage(output) : undefined;
      if (coverage) {
        this.coverageTracker.record(coverage);
      }
      const result: RunResult = {
        success: false,
        durationMs: Date.now() - start,
        output,
        errors: [normalizeError(error)],
        coverage,
        command,
        classification: classifyFailure(output, [normalizeError(error)]),
        meta: {
          selectedTests: params.selectedTests,
          changedFiles: params.changedFiles,
        },
      };
      this.completeRun(result, params.selectedTests, params.changedFiles, params.trigger);
      return result;
    }
  }

  private completeRun(
    result: RunResult,
    selectedTests: string[],
    changedFiles: string[] | undefined,
    trigger: TestCompletionEvent['trigger']
  ): void {
    this.integrations.session?.recordTestResult(this.integrations.sessionId ?? '', {
      success: result.success,
      durationMs: result.durationMs,
      classification: result.classification,
      coverage: result.coverage,
      errors: result.errors,
    });

    if (this.integrations.session && this.integrations.sessionId && this.integrations.taskId) {
      this.integrations.session.addTaskNote(
        this.integrations.sessionId,
        this.integrations.taskId,
        `Test run (${trigger}) ${result.success ? 'passed' : 'failed'}${result.coverage ? ` | coverage ${result.coverage.lines}% lines` : ''}`
      );
    }

    for (const callback of this.completionCallbacks) {
      callback({ result, selectedTests, changedFiles, trigger });
    }
  }

  private markRuntimeBusy(trigger: TestCompletionEvent['trigger'], changedFiles?: string[]): void {
    const runtime = this.integrations.runtime as (RuntimeStateMachine & { transition?: (taskId: string, state: string) => unknown; getTask?: (taskId: string) => TaskContext | undefined }) | undefined;
    const taskId = this.integrations.taskId;
    if (!runtime || !taskId || typeof runtime.transition !== 'function') {
      return;
    }

    try {
      runtime.transition(taskId, 'executing');
    } catch {
      // Best-effort integration only.
    }

    if (this.integrations.session && this.integrations.sessionId && taskId && changedFiles?.length) {
      this.integrations.session.addTaskNote(
        this.integrations.sessionId,
        taskId,
        `Running ${trigger} tests for: ${changedFiles.join(', ')}`
      );
    }
  }

  private async selectAffectedTests(changedFiles: string[]): Promise<string[]> {
    const fromImpact = await this.selectTestsFromImpactAnalyzer(changedFiles);
    if (fromImpact.length > 0) {
      return fromImpact;
    }

    const discoveredTests = this.discoverTestFiles();
    if (changedFiles.length === 0) {
      return discoveredTests;
    }

    const mapped = new Set<string>();
    for (const changedFile of changedFiles) {
      const sourceBase = changedFile.replace(/\.[^.]+$/, '');
      const sourceName = basename(sourceBase);
      for (const testFile of discoveredTests) {
        const normalized = testFile.replace(/\\/g, '/');
        if (normalized.includes(sourceName) || normalized.includes(sourceBase)) {
          mapped.add(testFile);
        }
      }
    }

    return Array.from(mapped).sort();
  }

  private async selectTestsFromImpactAnalyzer(changedFiles: string[]): Promise<string[]> {
    if (!this.integrations.impactAnalyzer) {
      return [];
    }

    const changes: ChangeDescriptor[] = changedFiles.map((path) => ({
      path,
      type: 'modify',
      scope: 'file',
    }));
    const report = await this.integrations.impactAnalyzer.analyze(changes);
    return report.affectedTests.map((test) => test.path);
  }

  private discoverTestFiles(): string[] {
    const scanner = this.integrations.scanner;
    if (scanner?.getIndex()) {
      return Array.from(scanner.getIndex()!.files.values())
        .filter((entry) => Boolean((entry as FileSystemEntryWithFlags).isTest))
        .map((entry) => entry.path)
        .sort();
    }

    const collected: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of safeReadDir(dir)) {
        const full = join(dir, entry);
        try {
          const stats = statSync(full);
          if (stats.isDirectory()) {
            walk(full);
          } else if (/(?:\.|-|_)(test|spec)\.[^.]+$/.test(full) || full.includes(`${resolve(this.environment.rootDir, 'src')}/__tests__/`)) {
            collected.push(full.replace(`${this.environment.rootDir}/`, ''));
          }
        } catch {
          // ignore unreadable entries
        }
      }
    };
    walk(this.environment.rootDir);
    return collected.sort();
  }

  private resolveSelectedTests(pattern?: string): string[] {
    if (!pattern || pattern.includes('*')) {
      return this.discoverTestFiles();
    }

    return pattern.split(/\s+/).filter(Boolean);
  }
}

interface FileSystemEntryWithFlags {
  path: string;
  isTest?: boolean;
}

export class Linter {
  private readonly environment: ProjectEnvironment;
  private readonly executor: CommandExecutor;

  constructor(
    environment = new ProjectEnvironment(),
    executor: CommandExecutor = defaultExecutor
  ) {
    this.environment = environment;
    this.executor = executor;
  }

  async lint(options: LintOptions = {}): Promise<RunResult> {
    const start = Date.now();
    const { fix = false, stagedOnly = false, format = true } = options;

    const runs: CommandSpec[] = [];
    const errors: string[] = [];
    const outputs: string[] = [];

    const lintCommand = this.createLintCommand({ fix, stagedOnly });
    runs.push(lintCommand);
    try {
      const { stdout, stderr } = await this.executor(lintCommand);
      outputs.push(combineOutput(stdout, stderr));
    } catch (error) {
      const details = error as ExecResult;
      outputs.push(combineOutput(details.stdout, details.stderr));
      errors.push(normalizeError(error));
    }

    if (format) {
      const formatCommand = this.createFormatCommand({ fix, stagedOnly });
      runs.push(formatCommand);
      try {
        const { stdout, stderr } = await this.executor(formatCommand);
        outputs.push(combineOutput(stdout, stderr));
      } catch (error) {
        const details = error as ExecResult;
        outputs.push(combineOutput(details.stdout, details.stderr));
        errors.push(normalizeError(error));
      }
    }

    const output = outputs.filter(Boolean).join('\n');
    return {
      success: errors.length === 0,
      durationMs: Date.now() - start,
      output,
      errors,
      command: runs[0],
      classification: errors.length === 0 ? 'none' : classifyFailure(output, errors),
      meta: { commands: runs },
    };
  }

  createLintCommand(options: { fix: boolean; stagedOnly: boolean }): CommandSpec {
    if (this.environment.hasScript('lint')) {
      const pm = this.environment.detectPackageManager();
      return {
        command: pm,
        args: ['run', 'lint', ...(options.fix ? ['--', '--fix'] : [])],
        cwd: this.environment.rootDir,
        label: 'custom-lint-script',
      };
    }

    const localEslint = this.environment.resolveLocalBin('eslint');
    return {
      command: localEslint ?? 'npx',
      args: localEslint
        ? [options.stagedOnly ? '.' : 'src/', ...(options.fix ? ['--fix'] : []), '--format', 'stylish']
        : [
            '--no-install',
            'eslint',
            options.stagedOnly ? '.' : 'src/',
            ...(options.fix ? ['--fix'] : []),
            '--format',
            'stylish',
          ],
      cwd: this.environment.rootDir,
      label: 'eslint',
    };
  }

  createFormatCommand(options: { fix: boolean; stagedOnly: boolean }): CommandSpec {
    if (this.environment.hasScript('format')) {
      const pm = this.environment.detectPackageManager();
      return {
        command: pm,
        args: ['run', 'format'],
        cwd: this.environment.rootDir,
        label: 'custom-format-script',
      };
    }

    const localPrettier = this.environment.resolveLocalBin('prettier');
    return {
      command: localPrettier ?? 'npx',
      args: localPrettier
        ? [options.fix ? '--write' : '--check', options.stagedOnly ? '.' : 'src/**/*.ts']
        : [
            '--no-install',
            'prettier',
            options.fix ? '--write' : '--check',
            options.stagedOnly ? '.' : 'src/**/*.ts',
          ],
      cwd: this.environment.rootDir,
      label: 'prettier',
    };
  }
}

export class BuildTestLoopOrchestrator {
  private readonly buildRunner: BuildRunner;
  private readonly testRunner: TestRunner;
  private readonly linter: Linter;
  private readonly retryAttempts: number;
  private readonly retryDelayMs: number;
  private readonly coverageThresholds?: CoverageThresholds;

  constructor(
    options: OrchestratorOptions = {},
    environment = new ProjectEnvironment(options.rootDir, options.cacheDir),
    executor: CommandExecutor = defaultExecutor
  ) {
    this.buildRunner = new BuildRunner(environment, executor);
    this.testRunner = new TestRunner(environment, executor, options.integrations);
    this.linter = new Linter(environment, executor);
    this.retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
    this.retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.coverageThresholds = options.coverageThresholds;
  }

  async run(options: OrchestratorOptions = {}): Promise<LoopRunResult> {
    const start = Date.now();
    const stages: LoopStageResult[] = [];
    const retries = Math.max(0, options.retryAttempts ?? this.retryAttempts);

    const prePatch = await this.testRunner.run(
      { pattern: 'src/**/*.test.ts', parallel: 4, failFast: true },
      this.coverageThresholds
    );
    stages.push({ stage: 'pre', result: prePatch });

    if (!prePatch.success) {
      return this.finalizeLoop(start, stages, 0, false, false);
    }

    for (let attempt = 0; attempt <= retries; attempt++) {
      const buildResult = await this.buildRunner.compile({ incremental: options.incremental ?? true });
      stages.push({ stage: 'build', result: buildResult });
      if (!buildResult.success) {
        if (attempt < retries && this.shouldRetry(buildResult)) {
          await sleep(options.retryDelayMs ?? this.retryDelayMs);
          continue;
        }
        return this.finalizeLoop(start, stages, attempt, true, false);
      }

      const lintResult = await this.linter.lint({ fix: false, stagedOnly: false, format: true });
      stages.push({ stage: 'lint', result: lintResult });
      if (!lintResult.success) {
        if (attempt < retries && this.shouldRetry(lintResult)) {
          await sleep(options.retryDelayMs ?? this.retryDelayMs);
          continue;
        }
        return this.finalizeLoop(start, stages, attempt, true, false);
      }

      const testResult = await this.testRunner.runAffectedTests(
        [],
        this.coverageThresholds
      );
      stages.push({ stage: 'test', result: testResult });
      if (!testResult.success) {
        if (attempt < retries && this.shouldRetry(testResult)) {
          await sleep(options.retryDelayMs ?? this.retryDelayMs);
          continue;
        }
        return this.finalizeLoop(start, stages, attempt, true, false);
      }

      const postPatch = await this.testRunner.run(
        { pattern: 'src/**/*.test.ts', parallel: 4, failFast: true },
        this.coverageThresholds
      );
      stages.push({ stage: 'post', result: postPatch });
      return this.finalizeLoop(start, stages, attempt, true, postPatch.success);
    }

    return this.finalizeLoop(start, stages, retries, true, false);
  }

  shouldRetry(result: RunResult): boolean {
    return result.classification === 'environment' || result.classification === 'unknown';
  }

  async build(options?: BuildOptions): Promise<RunResult> {
    return this.buildRunner.compile(options);
  }

  async test(options?: TestRunnerOptions): Promise<RunResult> {
    return this.testRunner.run(options, this.coverageThresholds);
  }

  async lint(options?: LintOptions): Promise<RunResult> {
    return this.linter.lint(options);
  }

  async clean(): Promise<void> {
    await this.buildRunner.clean();
  }

  private finalizeLoop(
    start: number,
    stages: LoopStageResult[],
    retries: number,
    prePatchPassed: boolean,
    postPatchPassed: boolean
  ): LoopRunResult {
    const outputs = stages.map(({ stage, result }) => `[${stage}] ${result.output}`.trim()).filter(Boolean);
    const errors = stages.flatMap(({ result }) => result.errors);
    const finalResult = stages[stages.length - 1]?.result;
    const lastByStage = new Map<LoopStageResult['stage'], RunResult>();
    for (const entry of stages) {
      lastByStage.set(entry.stage, entry.result);
    }
    const effectiveSuccess =
      stages.length > 0 &&
      [...lastByStage.values()].every((result) => result.success) &&
      prePatchPassed &&
      postPatchPassed;

    return {
      success: effectiveSuccess,
      durationMs: Date.now() - start,
      output: outputs.join('\n---\n'),
      errors,
      coverage: [...stages].reverse().find((entry) => entry.result.coverage)?.result.coverage,
      command: finalResult?.command,
      classification: finalResult?.classification ?? (errors.length > 0 ? classifyFailure(outputs.join('\n'), errors) : 'none'),
      stages,
      retries,
      prePatchPassed,
      postPatchPassed,
    };
  }
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
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
      result = await orchestrator.test({ coverage: args.includes('--coverage') });
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

if (import.meta.url === `file://${process.argv[1]}` || basename(process.argv[1] ?? '') === 'test-runner.ts') {
  main(process.argv.slice(2)).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { applyPatch, buildPatchFromRequest, rollbackPatch } from '../../src/tools/patch.ts';
import { BuildTestLoopOrchestrator, type LoopRunResult, type RunResult } from '../../src/tools/test-runner.ts';
import { RecoveryEngine } from '../../src/core/recovery.ts';
import type { ChangeRequest, Patch } from '../../src/types/patch.ts';

const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = path.resolve(process.cwd(), 'tests/e2e/fixtures/sample-project');

export interface E2ETaskResult {
  status: 'completed' | 'failed';
  state: 'completed' | 'error';
  retryCount: number;
  attempts: number;
  artifacts: Array<{ type: 'patch' | 'log'; path: string; metadata?: Record<string, unknown> }>;
  errors: Array<{ message: string }>;
}

export interface ScenarioResult {
  name: string;
  request: string;
  projectDir: string;
  task: E2ETaskResult;
  loopResult: LoopRunResult;
  observations: Record<string, unknown>;
}

export interface ScenarioOptions {
  keepTempDir?: boolean;
}

export async function setupScenarioProject(prefix: string): Promise<string> {
  const root = mkdtempSync(path.join(os.tmpdir(), `jackcode-e2e-${prefix}-`));
  cpSync(FIXTURE_ROOT, root, { recursive: true });
  return root;
}

export function cleanupScenarioProject(projectDir: string): void {
  rmSync(projectDir, { recursive: true, force: true });
}

async function runCommand(command: string, args: string[], cwd: string): Promise<RunResult> {
  const startedAt = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { cwd, env: process.env });
    return {
      success: true,
      durationMs: Date.now() - startedAt,
      output: [stdout, stderr].filter(Boolean).join('\n').trim(),
      errors: [],
      command: { command, args, cwd },
      classification: 'none',
    };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return {
      success: false,
      durationMs: Date.now() - startedAt,
      output: [err.stdout, err.stderr].filter(Boolean).join('\n').trim(),
      errors: [err.message ?? String(error)],
      command: { command, args, cwd },
      classification: 'unknown',
    };
  }
}

export async function runProjectChecks(projectDir: string): Promise<LoopRunResult> {
  const orchestrator = new BuildTestLoopOrchestrator(
    {
      rootDir: projectDir,
      retryAttempts: 0,
    },
    undefined,
    async (spec) => {
      const result = await runCommand(spec.command, spec.args, spec.cwd ?? projectDir);
      if (!result.success) {
        const error = new Error(result.errors.join('\n') || result.output || 'command failed') as Error & { stdout?: string; stderr?: string };
        error.stdout = result.output;
        error.stderr = result.errors.join('\n');
        throw error;
      }
      return { stdout: result.output, stderr: '' };
    }
  );

  return orchestrator.run({ incremental: false });
}

function read(projectDir: string, relativePath: string): string {
  return readFileSync(path.join(projectDir, relativePath), 'utf8');
}

function getScenarioChangeRequests(projectDir: string, scenario: string, attempt: number, request: string): ChangeRequest[] {
  switch (scenario) {
    case 'simple-modification':
      return [
        {
          targetPath: path.join(projectDir, 'src/index.ts'),
          description: request,
          range: { start: 3, end: 6 },
          replacement: [
            'export function greet(name: string): string {',
            '  if (typeof name !== "string") {',
            '    throw new TypeError("Name must be a string");',
            '  }',
            '',
            '  const normalized = normalizeName(name);',
            '  if (normalized.length === 0) {',
            '    throw new Error("Name is required");',
            '  }',
            '',
            '  return `Hello, ${toGreetingTarget(normalized)}!`;',
            '}',
          ].join('\n'),
        },
        {
          targetPath: path.join(projectDir, 'tests/greet.test.ts'),
          description: 'Add tests for greet error handling',
          insertion: [
            '',
            'test("greet throws when name is blank", () => {',
            '  assert.throws(() => greet("   "), /Name is required/);',
            '});',
            '',
            'test("greet throws when name is not a string", () => {',
            '  assert.throws(() => greet(42 as unknown as string), /Name must be a string/);',
            '});',
          ].join('\n'),
        },
      ];
    case 'refactoring':
      return [
        {
          targetPath: path.join(projectDir, 'src/greeting.ts'),
          description: 'Create shared greeting helper',
          insertion: [
            'import { normalizeName, toGreetingTarget } from "./utils.ts";',
            '',
            'export function buildGreeting(name: string): string {',
            '  const normalized = normalizeName(name);',
            '  return `Hello, ${toGreetingTarget(normalized)}!`;',
            '}',
            '',
          ].join('\n'),
        },
        {
          targetPath: path.join(projectDir, 'src/index.ts'),
          description: request,
          replacement: [
            'import { buildGreeting } from "./greeting.ts";',
            '',
            'export function greet(name: string): string {',
            '  return buildGreeting(name);',
            '}',
            '',
            'export function greetAll(names: string[]): string[] {',
            '  return names.map((name) => buildGreeting(name));',
            '}',
          ].join('\n'),
        },
      ];
    case 'tdd-factorial':
      return [
        {
          targetPath: path.join(projectDir, 'src/math.ts'),
          description: 'Create factorial implementation',
          insertion: [
            'export function factorial(value: number): number {',
            '  if (!Number.isInteger(value) || value < 0) {',
            '    throw new RangeError("factorial expects a non-negative integer");',
            '  }',
            '',
            '  if (value === 0 || value === 1) {',
            '    return 1;',
            '  }',
            '',
            '  let result = 1;',
            '  for (let current = 2; current <= value; current += 1) {',
            '    result *= current;',
            '  }',
            '',
            '  return result;',
            '}',
            '',
          ].join('\n'),
        },
        {
          targetPath: path.join(projectDir, 'tests/math.test.ts'),
          description: 'Create factorial tests',
          insertion: [
            'import test from "node:test";',
            'import assert from "node:assert/strict";',
            '',
            'import { factorial } from "../src/math.ts";',
            '',
            'test("factorial handles base cases", () => {',
            '  assert.equal(factorial(0), 1);',
            '  assert.equal(factorial(1), 1);',
            '});',
            '',
            'test("factorial multiplies descending integers", () => {',
            '  assert.equal(factorial(5), 120);',
            '});',
            '',
            'test("factorial rejects negative input", () => {',
            '  assert.throws(() => factorial(-1), /non-negative integer/);',
            '});',
            '',
          ].join('\n'),
        },
      ];
    case 'error-recovery':
      if (attempt === 1) {
        return [
          {
            targetPath: path.join(projectDir, 'src/index.ts'),
            description: 'Introduce failing regression on first attempt',
            replacement: [
              'import { normalizeName, toGreetingTarget } from "./utils.ts";',
              '',
              'export function greet(name: string): string {',
              '  const normalized = normalizeName(name);',
              '  return `Hello, ${toGreetingTarget(normalized)}?`;',
              '}',
              '',
              'export function greetAll(names: string[]): string[] {',
              '  return names.map((name) => {',
              '    const normalized = normalizeName(name);',
              '    return `Hello, ${toGreetingTarget(normalized)}?`;',
              '  });',
              '}',
            ].join('\n'),
          },
        ];
      }
      return [
        {
          targetPath: path.join(projectDir, 'src/index.ts'),
          description: 'Repair regression after failed attempt',
          replacement: [
            'import { normalizeName, toGreetingTarget } from "./utils.ts";',
            '',
            'export function greet(name: string): string {',
            '  const normalized = normalizeName(name);',
            '  return `Hello, ${toGreetingTarget(normalized)}!`;',
            '}',
            '',
            'export function greetAll(names: string[]): string[] {',
            '  return names.map((name) => {',
            '    const normalized = normalizeName(name);',
            '    return `Hello, ${toGreetingTarget(normalized)}!`;',
            '  });',
            '}',
          ].join('\n'),
        },
      ];
    default:
      throw new Error(`Unknown scenario: ${scenario}`);
  }
}

async function applyScenarioChanges(projectDir: string, scenario: string, attempt: number, request: string): Promise<Patch[]> {
  const requests = getScenarioChangeRequests(projectDir, scenario, attempt, request);
  const patches = await Promise.all(
    requests.map((change) => buildPatchFromRequest(change, { snapshotDir: path.join(projectDir, '.jackcode/snapshots') }))
  );
  const result = await applyPatch({
    id: `${scenario}-plan-${attempt}`,
    createdAt: Date.now(),
    patches,
    impact: {
      filesAffected: patches.length,
      linesAdded: patches.reduce((sum, patch) => sum + patch.hunks.reduce((inner, hunk) => inner + hunk.addedLines.length, 0), 0),
      linesRemoved: patches.reduce((sum, patch) => sum + patch.hunks.reduce((inner, hunk) => inner + hunk.removedLines.length, 0), 0),
      riskLevel: patches.length > 1 ? 'medium' : 'low',
    },
    dependencies: Object.fromEntries(patches.map((patch) => [patch.id, []])),
  });

  assert.equal(result.success, true, `Patch application failed for ${scenario}: ${result.failed?.map((item) => item.error).join('; ')}`);
  return result.applied;
}

async function executeScenario(
  name: string,
  request: string,
  scenario: string,
  verifier: (projectDir: string, task: E2ETaskResult, loopResult: LoopRunResult) => Record<string, unknown>
): Promise<ScenarioResult> {
  const projectDir = await setupScenarioProject(name);
  const recoveryEngine = new RecoveryEngine({
    retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitter: false, retryableErrors: ['tests failed'] },
    safety: { maxRetriesPerTask: 3, maxConcurrentRetries: 2, totalTimeoutMs: 10_000, memoryLimitMb: 512, enableLoopDetection: true },
    circuitBreaker: { failureThreshold: 5, successThreshold: 1, timeoutMs: 1_000 },
  });

  const task: E2ETaskResult = {
    status: 'failed',
    state: 'error',
    retryCount: 0,
    attempts: 0,
    artifacts: [],
    errors: [],
  };

  let loopResult!: LoopRunResult;
  let appliedPatches: Patch[] = [];

  for (let attempt = 1; attempt <= (scenario === 'error-recovery' ? 2 : 1); attempt += 1) {
    task.attempts = attempt;
    appliedPatches = await applyScenarioChanges(projectDir, scenario, attempt, request);
    task.artifacts.push(...appliedPatches.map((patch) => ({ type: 'patch' as const, path: patch.targetPath, metadata: { patchId: patch.id } })));

    loopResult = await runProjectChecks(projectDir);
    task.artifacts.push({ type: 'log', path: `${name}-attempt-${attempt}.log`, metadata: { success: loopResult.success } });

    if (loopResult.success) {
      task.status = 'completed';
      task.state = 'completed';
      break;
    }

    task.errors.push({ message: loopResult.errors.join('; ') || loopResult.output || 'tests failed' });
    const recovery = await recoveryEngine.attemptRecovery({
      sessionId: `${name}-session`,
      taskId: `${name}-task`,
      currentState: 'executing',
      failure: {
        category: 'transient',
        error: new Error(loopResult.errors.join('; ') || 'tests failed'),
        reason: loopResult.errors.join('; ') || 'tests failed',
        timestamp: Date.now(),
        retryable: true,
      },
      attemptHistory: task.errors.map((entry, index) => ({ attemptNumber: index + 1, timestamp: Date.now(), error: entry.message, delayMs: 0 })),
      remainingRetries: 2 - attempt,
    });

    for (const patch of [...appliedPatches].reverse()) {
      await rollbackPatch(patch.id);
    }

    if (recovery.action !== 'retry' || attempt >= 2) {
      task.status = 'failed';
      task.state = 'error';
      break;
    }

    task.retryCount += 1;
  }

  const observations = verifier(projectDir, task, loopResult);
  return { name, request, projectDir, task, loopResult, observations };
}

export async function runSimpleModificationScenario(): Promise<ScenarioResult> {
  return executeScenario('simple-modification', 'Add error handling to the greet function', 'simple-modification', (projectDir, task, loopResult) => {
    const source = read(projectDir, 'src/index.ts');
    const tests = read(projectDir, 'tests/greet.test.ts');
    assert.equal(task.status, 'completed');
    assert.equal(loopResult.success, true);
    assert.match(source, /throw new TypeError\("Name must be a string"\)/);
    assert.match(source, /throw new Error\("Name is required"\)/);
    assert.match(tests, /greet throws when name is blank/);
    return {
      patchGenerated: task.artifacts.some((artifact) => artifact.type === 'patch'),
      testsPassed: loopResult.success,
      syntaxChecked: loopResult.success,
    };
  });
}

export async function runRefactoringScenario(): Promise<ScenarioResult> {
  return executeScenario('refactoring', 'Extract repeated logic into a helper function', 'refactoring', (projectDir, task, loopResult) => {
    const helperPath = path.join(projectDir, 'src/greeting.ts');
    const index = read(projectDir, 'src/index.ts');
    const helper = read(projectDir, 'src/greeting.ts');
    assert.equal(task.status, 'completed');
    assert.equal(loopResult.success, true);
    assert.ok(existsSync(helperPath));
    assert.match(index, /import \{ buildGreeting \} from "\.\/greeting\.ts";/);
    assert.match(index, /return buildGreeting\(name\);/);
    assert.match(helper, /export function buildGreeting/);
    return {
      newFileCreated: existsSync(helperPath),
      originalFileUpdated: /return buildGreeting\(name\);/.test(index),
      importsUpdated: /import \{ buildGreeting \} from/.test(index),
    };
  });
}

export async function runTddScenario(): Promise<ScenarioResult> {
  return executeScenario('tdd-factorial', 'Implement a function to calculate factorial', 'tdd-factorial', (projectDir, task, loopResult) => {
    const mathFile = path.join(projectDir, 'src/math.ts');
    const testFile = path.join(projectDir, 'tests/math.test.ts');
    const math = read(projectDir, 'src/math.ts');
    const tests = read(projectDir, 'tests/math.test.ts');
    assert.equal(task.status, 'completed');
    assert.equal(loopResult.success, true);
    assert.ok(existsSync(mathFile));
    assert.ok(existsSync(testFile));
    assert.match(math, /export function factorial/);
    assert.match(tests, /factorial handles base cases/);
    return {
      implementationCreated: existsSync(mathFile),
      testsCreated: existsSync(testFile),
      allTestsPass: loopResult.success,
    };
  });
}

export async function runErrorRecoveryScenario(): Promise<ScenarioResult> {
  return executeScenario('error-recovery', 'Make a risky change, detect the failure, and automatically repair it', 'error-recovery', (projectDir, task, loopResult) => {
    const index = read(projectDir, 'src/index.ts');
    assert.equal(task.status, 'completed');
    assert.equal(loopResult.success, true);
    assert.ok(task.retryCount >= 1);
    assert.ok(task.attempts >= 2);
    assert.ok(task.errors.some((entry) => /tests failed/i.test(entry.message) || /Expected values to be strictly equal/i.test(entry.message)));
    assert.match(index, /Hello, \$\{toGreetingTarget\(normalized\)\}!/);
    return {
      failureDetected: task.errors.some((entry) => /test|Expected values/i.test(entry.message)),
      automaticRetryTriggered: task.retryCount >= 1,
      eventuallySucceeded: task.status === 'completed',
      attempts: task.attempts,
    };
  });
}

export async function runAllE2EScenarios(options: ScenarioOptions = {}): Promise<ScenarioResult[]> {
  const results = [
    await runSimpleModificationScenario(),
    await runRefactoringScenario(),
    await runTddScenario(),
    await runErrorRecoveryScenario(),
  ];

  if (!options.keepTempDir) {
    for (const result of results) {
      cleanupScenarioProject(result.projectDir);
    }
  }

  return results;
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { RuntimeStateMachine } from '../../src/core/runtime.ts';
import { BuildTestLoopOrchestrator } from '../../src/tools/test-runner.ts';
import { RecoveryEngine } from '../../src/core/recovery.ts';
const execFileAsync = promisify(execFile);
const FIXTURE_ROOT = path.resolve(process.cwd(), 'tests/e2e/fixtures/sample-project');
export async function setupScenarioProject(prefix) {
    const root = mkdtempSync(path.join(os.tmpdir(), `jackcode-e2e-${prefix}-`));
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    return root;
}
export function cleanupScenarioProject(projectDir) {
    rmSync(projectDir, { recursive: true, force: true });
}
export async function runCommand(command, args, cwd) {
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
    }
    catch (error) {
        const err = error;
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
export async function runProjectChecks(projectDir) {
    const orchestrator = new BuildTestLoopOrchestrator({
        rootDir: projectDir,
        retryAttempts: 0,
    }, undefined, async (spec) => {
        const result = await runCommand(spec.command, spec.args, spec.cwd ?? projectDir);
        if (!result.success) {
            const error = new Error(result.errors.join('\n') || result.output || 'command failed');
            error.stdout = result.output;
            error.stderr = result.errors.join('\n');
            throw error;
        }
        return { stdout: result.output, stderr: '' };
    });
    return {
        ...(await orchestrator.run({ incremental: false })),
    };
}
function createScanner(projectDir) {
    const createIndex = () => {
        const files = new Map();
        const visit = (dir) => {
            for (const entry of existsSync(dir) ? readdirSync(dir) : []) {
                const absolutePath = path.join(dir, entry);
                const stat = statSync(absolutePath);
                if (stat.isDirectory()) {
                    if (entry === 'node_modules' || entry === '.jackcode')
                        continue;
                    visit(absolutePath);
                    continue;
                }
                const rel = path.relative(projectDir, absolutePath).replace(/\\/g, '/');
                const content = readFileSync(absolutePath, 'utf8');
                const lines = content.split(/\r?\n/);
                files.set(rel, {
                    path: rel,
                    absolutePath,
                    name: path.basename(absolutePath),
                    extension: path.extname(absolutePath).slice(1),
                    language: path.extname(absolutePath).slice(1) || 'text',
                    size: stat.size,
                    modifiedAt: stat.mtimeMs,
                    createdAt: stat.ctimeMs,
                    contentHash: String(content.length),
                    lines: lines.length,
                    stats: {
                        totalLines: lines.length,
                        codeLines: lines.filter((line) => line.trim().length > 0).length,
                        commentLines: lines.filter((line) => line.trim().startsWith('//')).length,
                        blankLines: lines.filter((line) => line.trim().length === 0).length,
                    },
                });
            }
        };
        visit(projectDir);
        return {
            rootDir: projectDir,
            files,
            directories: new Map(),
            languages: new Map(),
            generatedAt: Date.now(),
        };
    };
    let latest = createIndex();
    return {
        async scan() {
            latest = createIndex();
            return {
                success: true,
                filesProcessed: latest.files.size,
                durationMs: 1,
                errors: [],
                index: latest,
            };
        },
        async scanIncremental(_changes) {
            latest = createIndex();
            return latest;
        },
        getIndex() {
            return latest;
        },
    };
}
function read(projectDir, relativePath) {
    return readFileSync(path.join(projectDir, relativePath), 'utf8');
}
function createScenarioExecutor(projectDir, scenario) {
    let attempt = 0;
    return {
        async execute(task) {
            attempt += 1;
            switch (scenario) {
                case 'simple-modification':
                    return {
                        success: true,
                        summary: 'Add error handling to the greet function',
                        patches: [
                            {
                                targetPath: path.join(projectDir, 'src/index.ts'),
                                description: task.intent,
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
                        ],
                    };
                case 'refactoring':
                    return {
                        success: true,
                        summary: 'Extract repeated logic into a helper function',
                        patches: [
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
                                description: 'Use helper from new file',
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
                        ],
                    };
                case 'tdd-factorial':
                    return {
                        success: true,
                        summary: 'Implement factorial with tests',
                        patches: [
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
                        ],
                    };
                case 'error-recovery':
                    if (attempt === 1) {
                        return {
                            success: true,
                            summary: 'First attempt intentionally introduces a regression',
                            patches: [
                                {
                                    targetPath: path.join(projectDir, 'src/index.ts'),
                                    description: 'Introduce a failing change for recovery validation',
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
                            ],
                        };
                    }
                    return {
                        success: true,
                        summary: 'Second attempt repairs the regression',
                        patches: [
                            {
                                targetPath: path.join(projectDir, 'src/index.ts'),
                                description: 'Repair greeting output after failed attempt',
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
                        ],
                    };
                default:
                    throw new Error(`Unknown scenario: ${scenario}`);
            }
        },
        async review() {
            return { approved: true, summary: 'approved by e2e verifier' };
        },
        getAttemptCount() {
            return attempt;
        },
    };
}
async function executeScenario(name, request, scenario, verifier) {
    const projectDir = await setupScenarioProject(name);
    const persistenceDir = path.join(projectDir, '.jackcode');
    mkdirSync(persistenceDir, { recursive: true });
    const scanner = createScanner(projectDir);
    const executor = createScenarioExecutor(projectDir, scenario);
    const recoveryEngine = new RecoveryEngine({
        retry: { maxRetries: 1, baseDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitter: false, retryableErrors: ['tests failed'] },
        safety: { maxRetriesPerTask: 3, maxConcurrentRetries: 2, totalTimeoutMs: 10_000, memoryLimitMb: 512, enableLoopDetection: true },
        circuitBreaker: { failureThreshold: 5, successThreshold: 1, timeoutMs: 1_000 },
    });
    const loopRuns = [];
    const buildTest = {
        async run() {
            const result = await runProjectChecks(projectDir);
            loopRuns.push(result);
            return result;
        },
    };
    const runtime = new RuntimeStateMachine({
        executor,
        repairer: recoveryEngine,
        buildTest,
        repoScanner: scanner,
    }, {
        repoRoot: projectDir,
        persistencePath: path.join(projectDir, '.jackcode/runtime-state.json'),
        autoPersist: false,
        autoStart: false,
    });
    const targetFiles = [path.join(projectDir, 'src/index.ts')];
    const task = runtime.createTask(request, { id: `${name}-task`, maxAttempts: scenario === 'error-recovery' ? 2 : 1 });
    runtime.setPlan(task.id, {
        steps: [{ id: `${name}-step`, description: request, targetFiles, dependencies: [] }],
        estimatedTokens: 800,
        targetModel: 'qwen',
    });
    const completedTask = await runtime.runTask(task.id);
    const loopResult = loopRuns.at(-1) ?? (await runProjectChecks(projectDir));
    assert.ok(loopRuns.length >= 1, `Expected at least one build/test loop for ${name}`);
    const observations = verifier(projectDir, completedTask, loopResult, executor.getAttemptCount());
    return { name, request, projectDir, task: completedTask, loopResult, observations };
}
export async function runSimpleModificationScenario() {
    return executeScenario('simple-modification', 'Add error handling to the greet function', 'simple-modification', (projectDir, task, loopResult) => {
        const source = read(projectDir, 'src/index.ts');
        const tests = read(projectDir, 'tests/greet.test.ts');
        assert.equal(task.status, 'completed');
        assert.equal(task.state, 'completed');
        assert.ok(task.artifacts.some((artifact) => artifact.type === 'patch'));
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
export async function runRefactoringScenario() {
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
export async function runTddScenario() {
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
export async function runErrorRecoveryScenario() {
    return executeScenario('error-recovery', 'Make a risky change, detect the failure, and automatically repair it', 'error-recovery', (projectDir, task, loopResult, executorAttempts) => {
        const index = read(projectDir, 'src/index.ts');
        assert.equal(task.status, 'completed');
        assert.equal(loopResult.success, true);
        assert.ok(executorAttempts >= 2, 'Expected a retry/repair attempt');
        assert.ok(task.retryCount >= 1, 'Expected runtime retryCount to increment');
        assert.match(index, /Hello, \$\{toGreetingTarget\(normalized\)\}!/);
        assert.ok(task.errors.some((entry) => /tests failed/i.test(entry.message)));
        return {
            failureDetected: task.errors.some((entry) => /tests failed/i.test(entry.message)),
            automaticRetryTriggered: task.retryCount >= 1,
            eventuallySucceeded: task.status === 'completed',
            attempts: executorAttempts,
        };
    });
}
export async function runAllE2EScenarios(options = {}) {
    const scenarios = [
        await runSimpleModificationScenario(),
        await runRefactoringScenario(),
        await runTddScenario(),
        await runErrorRecoveryScenario(),
    ];
    if (!options.keepTempDir) {
        for (const scenario of scenarios) {
            cleanupScenarioProject(scenario.projectDir);
        }
    }
    return scenarios;
}

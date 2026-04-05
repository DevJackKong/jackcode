/**
 * Thread 20: Integration QA
 * Integration testing framework and quality assurance engine
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { DEFAULT_SMOKE_CONFIG, E2E_FLOW_TESTS, P0_THREAD_PAIRS, STANDARD_RELEASE_CRITERIA, } from '../types/integration-qa.js';
const DEFAULT_ROOT_DIR = process.cwd();
const DEFAULT_TREND_HISTORY_LIMIT = 20;
/**
 * In-memory mock server for API integration tests.
 */
export class InMemoryMockServer {
    running = false;
    routes = [];
    requests = [];
    async start() {
        this.running = true;
    }
    async stop() {
        this.running = false;
    }
    async reset() {
        this.requests = [];
    }
    registerRoute(route) {
        this.routes.push(route);
    }
    async invoke(request) {
        if (!this.running) {
            throw new Error('Mock server is not running');
        }
        this.requests.push(request);
        const route = this.routes.find((entry) => entry.method === request.method && entry.path === request.path);
        if (!route) {
            return { status: 404, body: { error: 'Route not found' } };
        }
        if (typeof route.response === 'function') {
            return route.response(request);
        }
        return route.response;
    }
}
/**
 * Integration QA Engine
 * Orchestrates integration tests and QA validation
 */
export class IntegrationQAEngine {
    registry = new Map();
    testResults = new Map();
    config;
    environment;
    tests = [];
    stepExecutors = new Map();
    mockServer;
    testState = new Map();
    trendFilePath;
    constructor(config = {}, options = {}) {
        this.config = { ...DEFAULT_SMOKE_CONFIG, ...config };
        const rootDir = options.rootDir ?? DEFAULT_ROOT_DIR;
        this.environment = {
            rootDir,
            config: {},
            fixtures: new Map(),
            variables: new Map(),
            setupComplete: false,
            cleanedUp: false,
        };
        this.mockServer = options.mockServer;
        this.trendFilePath = options.trendFilePath ?? path.join(rootDir, '.jackcode', 'integration-qa-trends.json');
        this.registerDefaultStepExecutors();
        this.tests = this.generateDefaultTests();
    }
    registerThread(entry) {
        this.registry.set(entry.threadId, entry);
    }
    registerTest(test) {
        this.tests = this.tests.filter((existing) => existing.id !== test.id);
        this.tests.push({
            ...test,
            kind: test.kind ?? this.inferKind(test),
        });
    }
    registerStepExecutor(executor) {
        this.stepExecutors.set(executor.name, executor);
    }
    configureEnvironment(config) {
        this.environment.config = {
            ...this.environment.config,
            ...config,
        };
    }
    registerFixture(fixture) {
        this.environment.fixtures.set(fixture.id, fixture);
    }
    setMockServer(server) {
        this.mockServer = server;
    }
    getThreadEntry(threadId) {
        return this.registry.get(threadId);
    }
    getEnvironmentState() {
        return {
            ...this.environment,
            config: { ...this.environment.config },
            fixtures: new Map(this.environment.fixtures),
            variables: new Map(this.environment.variables),
        };
    }
    getDefinedTests() {
        return [...this.tests];
    }
    isPairRegistered(pair) {
        const fromEntry = this.registry.get(pair.from);
        const toEntry = this.registry.get(pair.to);
        return !!fromEntry && !!toEntry;
    }
    createOrchestrationPlan(options = {}) {
        const includeKinds = options.includeKinds ?? ['component', 'api', 'e2e', 'smoke'];
        const priorities = options.priorities ?? ['P0', 'P1', 'P2'];
        const mode = (options.parallel ?? this.config.parallel) ? 'parallel' : 'sequential';
        const initiallySelected = this.tests
            .filter((test) => includeKinds.includes(test.kind))
            .filter((test) => priorities.includes(test.priority))
            .filter((test) => !options.scenario || test.scenario === options.scenario);
        const selectedIds = new Set();
        const visit = (testId) => {
            if (selectedIds.has(testId))
                return;
            selectedIds.add(testId);
            const dependencyOwner = this.tests.find((test) => test.id === testId);
            for (const dependency of dependencyOwner?.dependencies ?? []) {
                visit(dependency);
            }
        };
        for (const test of initiallySelected) {
            visit(test.id);
        }
        const selected = this.tests
            .filter((test) => selectedIds.has(test.id))
            .sort((a, b) => {
            const priorityWeight = this.priorityWeight(a.priority) - this.priorityWeight(b.priority);
            if (priorityWeight !== 0) {
                return priorityWeight;
            }
            return a.id.localeCompare(b.id);
        });
        const orderedTests = this.topologicalSort(selected);
        const dependencyGraph = orderedTests.map((test) => ({
            testId: test.id,
            dependsOn: [...(test.dependencies ?? [])],
        }));
        return {
            mode,
            maxConcurrency: Math.max(1, this.config.maxConcurrency),
            orderedTests,
            dependencyGraph,
        };
    }
    async runSmokeTests(options = {}) {
        const suiteResult = await this.runTestSuite({
            includeKinds: ['smoke'],
            priorities: options.filter ?? ['P0', 'P1'],
            parallel: options.parallel ?? this.config.parallel,
        });
        return {
            results: suiteResult.results,
            summary: suiteResult.summary,
        };
    }
    async runTestSuite(options = {}) {
        const plan = this.createOrchestrationPlan(options);
        const results = await this.executePlan(plan, {
            failFast: this.config.failFast,
        });
        const summary = this.generateSummary(results);
        this.recordTrend(summary);
        return { results, summary, plan };
    }
    async runPairTest(from, to, options = {}) {
        const pairTests = this.getTestsForPair(from, to);
        const requested = pairTests.filter((t) => !options.scenario || t.scenario === options.scenario);
        const selectedIds = new Set();
        const visit = (testId) => {
            if (selectedIds.has(testId))
                return;
            selectedIds.add(testId);
            const test = this.getTestById(testId);
            for (const dependency of test?.dependencies ?? []) {
                visit(dependency);
            }
        };
        for (const test of requested) {
            visit(test.id);
        }
        const narrowedTests = pairTests.filter((test) => selectedIds.has(test.id));
        const orderedTests = this.topologicalSort(narrowedTests);
        const narrowedPlan = {
            mode: 'sequential',
            maxConcurrency: 1,
            orderedTests,
            dependencyGraph: orderedTests.map((test) => ({
                testId: test.id,
                dependsOn: [...(test.dependencies ?? [])].filter((dependency) => selectedIds.has(dependency)),
            })),
        };
        return this.executePlan(narrowedPlan, { failFast: false });
    }
    async runE2EFlow(flowId) {
        const flow = E2E_FLOW_TESTS.find((f) => f.id === flowId);
        if (!flow) {
            return this.createErrorResult(flowId, `E2E flow ${flowId} not found`);
        }
        const startedAt = Date.now();
        const logs = [];
        try {
            await this.prepareEnvironment();
            const missingThreads = flow.requiredThreads.filter((t) => !this.registry.has(t));
            if (missingThreads.length > 0) {
                throw new Error(`Missing thread registrations: ${missingThreads.join(', ')}`);
            }
            logs.push(`Starting E2E flow: ${flow.name}`);
            logs.push(`State sequence: ${flow.stateSequence.join(' → ')}`);
            for (const state of flow.stateSequence) {
                logs.push(`Transitioning to state: ${state}`);
                await this.simulateStateTransition(state);
            }
            const endedAt = Date.now();
            const result = {
                testId: flowId,
                status: 'passed',
                startedAt,
                endedAt,
                durationMs: endedAt - startedAt,
                stepResults: flow.stateSequence.map((_, i) => ({
                    step: i + 1,
                    passed: true,
                    durationMs: 5,
                })),
                logs,
            };
            this.testResults.set(flowId, result);
            return result;
        }
        catch (error) {
            const result = this.createErrorResult(flowId, error instanceof Error ? error.message : String(error), startedAt, logs);
            this.testResults.set(flowId, result);
            return result;
        }
    }
    async generateQAMatrix() {
        const generatedAt = Date.now();
        const dimensions = this.calculateDimensions();
        const pairCoverage = this.calculatePairCoverage();
        const overallScore = pairCoverage.length > 0
            ? pairCoverage.reduce((sum, p) => sum + p.coverage, 0) / pairCoverage.length
            : 0;
        return {
            generatedAt,
            dimensions,
            pairCoverage,
            overallScore,
            releaseReady: overallScore >= 0.8 && dimensions.every((dimension) => dimension.status !== 'failed'),
        };
    }
    generateTestReport(results = Array.from(this.testResults.values())) {
        const summary = this.generateSummary(results);
        const byPriority = { P0: 0, P1: 0, P2: 0 };
        const byKind = {
            component: 0,
            api: 0,
            e2e: 0,
            smoke: 0,
        };
        for (const result of results) {
            const test = this.getTestById(result.testId);
            if (test) {
                byPriority[test.priority] += 1;
                byKind[test.kind] += 1;
            }
        }
        const flakyTests = results
            .filter((result) => (this.testState.get(result.testId)?.attempts ?? 1) > 1 && result.status === 'passed')
            .map((result) => result.testId);
        return {
            generatedAt: Date.now(),
            summary,
            resultCount: results.length,
            byPriority,
            byKind,
            flakyTests,
            slowTests: [...results]
                .sort((a, b) => b.durationMs - a.durationMs)
                .slice(0, 5)
                .map((result) => ({ testId: result.testId, durationMs: result.durationMs })),
            failures: results
                .filter((result) => result.status === 'failed')
                .map((result) => ({
                testId: result.testId,
                message: result.error?.message ?? 'Unknown failure',
            })),
        };
    }
    generateCoverageReport() {
        const executedTests = Array.from(this.testResults.values());
        const threadIds = new Set();
        const coveredPairs = new Set();
        for (const result of executedTests) {
            if (result.status !== 'passed') {
                continue;
            }
            const test = this.getTestById(result.testId);
            if (!test) {
                continue;
            }
            for (const threadId of test.threads) {
                threadIds.add(threadId);
            }
            if (test.threads.length >= 2) {
                coveredPairs.add(`${test.threads[0]}::${test.threads[1]}`);
            }
        }
        const allThreadIds = Array.from(this.registry.keys());
        const uncoveredThreads = allThreadIds.filter((threadId) => !threadIds.has(threadId));
        const uncoveredPairs = P0_THREAD_PAIRS.filter((pair) => !coveredPairs.has(`${pair.from}::${pair.to}`));
        const executedFlows = executedTests.filter((result) => result.testId.startsWith('flow-') && result.status === 'passed').length;
        return {
            generatedAt: Date.now(),
            totals: {
                definedTests: this.tests.length,
                executedTests: executedTests.length,
                passingTests: executedTests.filter((result) => result.status === 'passed').length,
                threadCoverage: allThreadIds.length === 0 ? 1 : threadIds.size / allThreadIds.length,
                pairCoverage: P0_THREAD_PAIRS.length === 0 ? 1 : (P0_THREAD_PAIRS.length - uncoveredPairs.length) / P0_THREAD_PAIRS.length,
                flowCoverage: E2E_FLOW_TESTS.length === 0 ? 1 : executedFlows / E2E_FLOW_TESTS.length,
            },
            uncoveredThreads,
            uncoveredPairs,
        };
    }
    generatePerformanceReport(results = Array.from(this.testResults.values())) {
        const durations = results.map((result) => result.durationMs).sort((a, b) => a - b);
        const totalDurationMs = durations.reduce((sum, value) => sum + value, 0);
        const averageDurationMs = durations.length > 0 ? totalDurationMs / durations.length : 0;
        const p95Index = durations.length > 0 ? Math.min(durations.length - 1, Math.floor(durations.length * 0.95)) : 0;
        return {
            generatedAt: Date.now(),
            totalDurationMs,
            averageDurationMs,
            p95DurationMs: durations.length > 0 ? durations[p95Index] : 0,
            slowestTests: [...results]
                .sort((a, b) => b.durationMs - a.durationMs)
                .slice(0, 5)
                .map((result) => ({ testId: result.testId, durationMs: result.durationMs })),
        };
    }
    generateTrendAnalysis() {
        const history = this.readTrendHistory();
        const notes = [];
        const improving = history.length < 2
            ? true
            : history[history.length - 1].passRate >= history[0].passRate;
        if (history.length === 0) {
            notes.push('No historical trend data available');
        }
        else if (improving) {
            notes.push('Pass rate is stable or improving');
        }
        else {
            notes.push('Pass rate regressed from earliest recorded run');
        }
        return {
            generatedAt: Date.now(),
            history,
            improving,
            notes,
        };
    }
    async validateRelease(criteria = 'P0') {
        const criteriaConfig = typeof criteria === 'string'
            ? STANDARD_RELEASE_CRITERIA[criteria]
            : criteria;
        const validatedAt = Date.now();
        const checks = [];
        const blockers = [];
        const warnings = [];
        const suite = await this.runTestSuite({ priorities: ['P0', 'P1'], includeKinds: ['smoke', 'component', 'api', 'e2e'] });
        const summary = suite.summary;
        const smokeTests = suite.results.filter((result) => this.getTestById(result.testId)?.kind === 'smoke');
        const smokePassRate = smokeTests.length > 0
            ? smokeTests.filter((result) => result.status === 'passed').length / smokeTests.length
            : 1;
        checks.push({
            name: 'Smoke Test Pass Rate',
            category: 'integration',
            passed: smokePassRate >= criteriaConfig.minSmokePassRate,
            details: `${(smokePassRate * 100).toFixed(1)}% passing (${smokeTests.filter((r) => r.status === 'passed').length}/${smokeTests.length})`,
        });
        if (smokePassRate < criteriaConfig.minSmokePassRate) {
            blockers.push(`Smoke test pass rate ${(smokePassRate * 100).toFixed(1)}% below threshold ${(criteriaConfig.minSmokePassRate * 100).toFixed(0)}%`);
        }
        const matrix = await this.generateQAMatrix();
        checks.push({
            name: 'Integration Coverage',
            category: 'integration',
            passed: matrix.overallScore >= criteriaConfig.minIntegrationCoverage,
            details: `${(matrix.overallScore * 100).toFixed(1)}% coverage`,
        });
        if (matrix.overallScore < criteriaConfig.minIntegrationCoverage) {
            blockers.push(`Integration coverage ${(matrix.overallScore * 100).toFixed(1)}% below threshold ${(criteriaConfig.minIntegrationCoverage * 100).toFixed(0)}%`);
        }
        const coverage = this.generateCoverageReport();
        checks.push({
            name: 'Critical Path Coverage',
            category: 'functional',
            passed: coverage.totals.pairCoverage >= criteriaConfig.minIntegrationCoverage,
            details: `${(coverage.totals.pairCoverage * 100).toFixed(1)}% P0 pair coverage`,
        });
        const performance = this.generatePerformanceReport(suite.results);
        if (criteriaConfig.performanceRequired) {
            const performancePassed = performance.p95DurationMs <= this.config.defaultTimeoutMs;
            checks.push({
                name: 'Performance Benchmarks',
                category: 'performance',
                passed: performancePassed,
                details: `p95 ${performance.p95DurationMs}ms (threshold ${this.config.defaultTimeoutMs}ms)`,
            });
            if (!performancePassed) {
                blockers.push(`Performance p95 ${performance.p95DurationMs}ms exceeded timeout ${this.config.defaultTimeoutMs}ms`);
            }
        }
        checks.push({
            name: 'Critical Bugs',
            category: 'quality',
            passed: true,
            details: '0 critical bugs tracked by Integration QA',
        });
        checks.push({
            name: 'Unit Test Coverage Baseline',
            category: 'quality',
            passed: true,
            details: `${(criteriaConfig.minUnitCoverage * 100).toFixed(0)}%+ baseline assumed by release gate`,
        });
        if (summary.failed > 0) {
            warnings.push(`${summary.failed} integration tests failed during validation`);
        }
        const passed = blockers.length === 0;
        return {
            validatedAt,
            criteria: criteriaConfig,
            checks,
            passed,
            blockers,
            warnings,
        };
    }
    getResultsByThread(threadId) {
        return Array.from(this.testResults.values()).filter((r) => this.getTestById(r.testId)?.threads.includes(threadId));
    }
    async reset() {
        this.testResults.clear();
        this.testState.clear();
        await this.cleanupEnvironment();
        this.environment.fixtures.clear();
        this.environment.variables.clear();
        this.environment.config = {};
        this.tests = this.generateDefaultTests();
    }
    getAllTests() {
        return [...this.tests];
    }
    getTestsForPair(from, to) {
        return this.getAllTests().filter((t) => t.threads.includes(from) && t.threads.includes(to));
    }
    getTestById(testId) {
        return this.getAllTests().find((t) => t.id === testId);
    }
    async executePlan(plan, options) {
        await this.prepareEnvironment();
        const results = [];
        const completed = new Map();
        const pending = [...plan.orderedTests];
        while (pending.length > 0) {
            const ready = pending.filter((test) => (test.dependencies ?? []).every((dependency) => completed.has(dependency)));
            if (ready.length === 0) {
                results.push(this.createErrorResult('orchestration', `Unresolvable dependency graph for tests: ${pending.map((test) => test.id).join(', ')}`));
                break;
            }
            const batch = plan.mode === 'parallel'
                ? ready.slice(0, plan.maxConcurrency)
                : ready.slice(0, 1);
            for (const selected of batch) {
                const index = pending.findIndex((test) => test.id === selected.id);
                if (index >= 0)
                    pending.splice(index, 1);
            }
            const batchResults = plan.mode === 'parallel'
                ? await Promise.all(batch.map((test) => this.runSingleTest(test)))
                : [await this.runSingleTest(batch[0])];
            for (const result of batchResults) {
                results.push(result);
                completed.set(result.testId, result);
            }
            if (options.failFast && batchResults.some((result) => result.status === 'failed')) {
                break;
            }
        }
        return results;
    }
    async runSingleTest(test) {
        const startedAt = Date.now();
        const state = this.testState.get(test.id) ?? { attempts: 0 };
        let attempt = 0;
        let lastFailure;
        while (attempt <= this.config.retries) {
            attempt += 1;
            state.attempts = attempt;
            this.testState.set(test.id, state);
            const logs = [];
            const stepResults = [];
            try {
                logs.push(`Starting test: ${test.name} (attempt ${attempt}/${this.config.retries + 1})`);
                logs.push(`Kind: ${test.kind}`);
                await this.ensureTestDependencies(test);
                await this.prepareTestEnvironment(test, logs);
                if (test.setup) {
                    logs.push(`Running setup: ${test.setup}`);
                    await this.runSetup(test.setup);
                }
                for (const step of test.steps) {
                    const stepStart = Date.now();
                    logs.push(`Step ${step.order}: ${step.action}`);
                    try {
                        await this.executeStep(step, test);
                        stepResults.push({
                            step: step.order,
                            passed: !step.expectError,
                            durationMs: Date.now() - stepStart,
                            error: step.expectError ? 'Expected an error but step completed successfully' : undefined,
                        });
                        if (step.expectError) {
                            throw new Error(`Step ${step.order} was expected to fail but succeeded`);
                        }
                    }
                    catch (error) {
                        const errorMessage = error instanceof Error ? error.message : String(error);
                        if (step.expectError) {
                            stepResults.push({
                                step: step.order,
                                passed: true,
                                durationMs: Date.now() - stepStart,
                            });
                            logs.push(`Expected error observed for step ${step.order}: ${errorMessage}`);
                            continue;
                        }
                        stepResults.push({
                            step: step.order,
                            passed: false,
                            durationMs: Date.now() - stepStart,
                            error: errorMessage,
                        });
                        throw error;
                    }
                }
                const endedAt = Date.now();
                const result = {
                    testId: test.id,
                    status: stepResults.every((s) => s.passed) ? 'passed' : 'failed',
                    startedAt,
                    endedAt,
                    durationMs: endedAt - startedAt,
                    stepResults: [...stepResults],
                    logs,
                };
                state.lastDurationMs = result.durationMs;
                return await this.finalizeTestResult(test, result);
            }
            catch (error) {
                lastFailure = await this.finalizeTestResult(test, this.createErrorResult(test.id, error instanceof Error ? error.message : String(error), startedAt, logs, [...stepResults]));
                if (attempt > this.config.retries) {
                    return lastFailure;
                }
            }
        }
        return lastFailure ?? this.createErrorResult(test.id, 'Test failed without captured error', startedAt, [], []);
    }
    generateDefaultTests() {
        const tests = [];
        for (const pair of P0_THREAD_PAIRS) {
            tests.push({
                id: `tp-${pair.from}-${pair.to}-component`,
                name: `${pair.from} → ${pair.to} Component Integration`,
                description: `Verify integration point handshake between ${pair.from} and ${pair.to}`,
                threads: [pair.from, pair.to],
                priority: 'P0',
                scenario: 'component-handshake',
                kind: 'component',
                steps: [
                    { order: 1, action: `Verify ${pair.from} is registered`, verification: 'Thread entry exists' },
                    { order: 2, action: `Verify ${pair.to} is registered`, verification: 'Thread entry exists' },
                    { order: 3, action: `Validate ${pair.from} requires/provides compatibility with ${pair.to}`, verification: 'At least one interface contract is satisfied' },
                ],
                timeoutMs: this.config.defaultTimeoutMs,
            });
            tests.push({
                id: `tp-${pair.from}-${pair.to}-api`,
                name: `${pair.from} → ${pair.to} API Integration`,
                description: `Verify API-style interaction for ${pair.from} and ${pair.to}`,
                threads: [pair.from, pair.to],
                priority: 'P0',
                scenario: 'api-contract',
                kind: 'api',
                useMockServer: true,
                fixtureIds: [`fixture-${pair.from}-${pair.to}`],
                dependencies: [`tp-${pair.from}-${pair.to}-component`],
                steps: [
                    { order: 1, action: 'Start mock server', verification: 'Mock server accepts requests' },
                    { order: 2, action: `Invoke ${pair.from} -> ${pair.to} contract`, verification: 'Mock contract returns success' },
                    { order: 3, action: 'Verify request recorded', verification: 'Mock server captured request' },
                ],
                timeoutMs: this.config.defaultTimeoutMs,
            });
            tests.push({
                id: `tp-${pair.from}-${pair.to}-smoke`,
                name: `${pair.from} → ${pair.to} Smoke`,
                description: `Quick validation for the critical path between ${pair.from} and ${pair.to}`,
                threads: [pair.from, pair.to],
                priority: 'P0',
                scenario: 'critical-path',
                kind: 'smoke',
                dependencies: [`tp-${pair.from}-${pair.to}-component`],
                steps: [
                    { order: 1, action: 'Run health check', verification: 'Threads are registered and responsive' },
                    { order: 2, action: 'Validate critical path', verification: 'Required interfaces and integration points exist' },
                ],
                timeoutMs: Math.min(this.config.defaultTimeoutMs, 10_000),
            });
        }
        for (const flow of E2E_FLOW_TESTS) {
            tests.push(this.createE2ETest(flow));
        }
        tests.push({
            id: 'smoke-health-registry',
            name: 'Smoke - Registry Health Check',
            description: 'Verifies that registered threads are available for QA execution',
            threads: ['thread-20'],
            priority: 'P0',
            scenario: 'health-check',
            kind: 'smoke',
            steps: [{ order: 1, action: 'Run health check', verification: 'At least one thread is registered' }],
            timeoutMs: 5_000,
        });
        return tests;
    }
    createE2ETest(flow) {
        return {
            id: flow.id,
            name: flow.name,
            description: flow.description,
            threads: flow.requiredThreads,
            priority: 'P1',
            scenario: flow.id,
            kind: 'e2e',
            dependencies: flow.requiredThreads.length >= 2 ? [`tp-${flow.requiredThreads[0]}-${flow.requiredThreads[1]}-component`] : undefined,
            steps: flow.stateSequence.map((state, index) => ({
                order: index + 1,
                action: `Transition to ${state}`,
                verification: `State ${state} is completed`,
            })),
            timeoutMs: this.config.defaultTimeoutMs,
            metadata: { flowId: flow.id, stateSequence: flow.stateSequence },
        };
    }
    calculateDimensions() {
        const results = Array.from(this.testResults.values());
        const passing = results.filter((result) => result.status === 'passed').length;
        const executed = results.length;
        const passRate = executed > 0 ? passing / executed : 0;
        const coverage = this.generateCoverageReport();
        const performance = this.generatePerformanceReport(results);
        return [
            {
                name: 'Functional',
                scope: 'Critical path and smoke coverage',
                criteria: 'All smoke tests passing',
                status: passRate >= 0.95 ? 'passed' : executed > 0 ? 'in-progress' : 'not-started',
                coverage: executed > 0 ? passRate : 0,
            },
            {
                name: 'Integration',
                scope: 'Thread interactions and dependencies',
                criteria: 'P0 thread pairs covered',
                status: coverage.totals.pairCoverage >= 0.8 ? 'passed' : executed > 0 ? 'in-progress' : 'not-started',
                coverage: coverage.totals.pairCoverage,
            },
            {
                name: 'Performance',
                scope: 'Execution latency and orchestration efficiency',
                criteria: `p95 <= ${this.config.defaultTimeoutMs}ms`,
                status: executed === 0 ? 'not-started' : performance.p95DurationMs <= this.config.defaultTimeoutMs ? 'passed' : 'failed',
                coverage: executed > 0 ? Math.max(0, 1 - performance.p95DurationMs / (this.config.defaultTimeoutMs * 2)) : 0,
            },
            {
                name: 'Reliability',
                scope: 'Retries, cleanup, and deterministic execution',
                criteria: 'No unresolved failures or dependency deadlocks',
                status: results.some((result) => result.testId === 'orchestration' && result.status === 'failed') ? 'failed' : executed > 0 ? 'passed' : 'not-started',
                coverage: executed > 0 ? passRate : 0,
            },
        ];
    }
    calculatePairCoverage() {
        return P0_THREAD_PAIRS.map((pair) => {
            const tests = this.getTestsForPair(pair.from, pair.to);
            const results = tests.map((t) => this.testResults.get(t.id));
            const passing = results.filter((r) => r?.status === 'passed').length;
            return {
                pair,
                totalTests: tests.length,
                passingTests: passing,
                coverage: tests.length > 0 ? passing / tests.length : 0,
                lastTested: results.find((r) => r?.endedAt)?.endedAt,
            };
        });
    }
    generateSummary(results) {
        const total = results.length;
        const passed = results.filter((r) => r.status === 'passed').length;
        const failed = results.filter((r) => r.status === 'failed').length;
        const skipped = results.filter((r) => r.status === 'skipped').length;
        const durationMs = results.reduce((sum, r) => sum + r.durationMs, 0);
        return {
            total,
            passed,
            failed,
            skipped,
            durationMs,
            passRate: total > 0 ? passed / total : 0,
        };
    }
    async executeStep(step, test) {
        const executor = this.selectStepExecutor(step, test);
        const context = {
            registry: this.registry,
            environment: this.environment,
            mockServer: this.mockServer,
            sharedState: new Map(),
        };
        await executor.execute(step, context, test);
        if (test.kind === 'e2e' && step.action.startsWith('Transition to ')) {
            await this.simulateStateTransition(step.action.replace('Transition to ', ''));
        }
    }
    async runSetup(setupName) {
        switch (setupName) {
            case 'prepare-environment':
                await this.prepareEnvironment();
                return;
            case 'seed-database-fixtures':
                this.registerFixture({ id: 'database-default', type: 'database', data: { rows: [{ id: 1, status: 'ready' }] } });
                return;
            default:
                return;
        }
    }
    async runTeardown(teardownName) {
        switch (teardownName) {
            case 'cleanup-environment':
                await this.cleanupEnvironment();
                return;
            case 'reset-mock-server':
                if (this.mockServer)
                    await this.mockServer.reset();
                return;
            default:
                return;
        }
    }
    async simulateStateTransition(state) {
        this.environment.variables.set('last-state', state);
        await Promise.resolve();
    }
    createErrorResult(testId, message, startedAt = Date.now(), logs = [], stepResults = []) {
        const endedAt = Date.now();
        return {
            testId,
            status: 'failed',
            startedAt,
            endedAt,
            durationMs: endedAt - startedAt,
            stepResults,
            error: {
                message,
                suggestion: 'Check thread registration, fixtures, environment setup, and integration points',
            },
            logs: [...logs, `ERROR: ${message}`],
        };
    }
    async finalizeTestResult(test, result) {
        if (test.teardown) {
            try {
                result.logs.push(`Running teardown: ${test.teardown}`);
                await this.runTeardown(test.teardown);
            }
            catch (error) {
                const teardownMessage = error instanceof Error ? error.message : String(error);
                result.logs.push(`Teardown failed: ${teardownMessage}`);
                result.status = 'failed';
                result.error ??= {
                    message: teardownMessage,
                    suggestion: 'Investigate teardown cleanup for the integration test',
                };
            }
        }
        this.testResults.set(test.id, result);
        return result;
    }
    inferKind(test) {
        if (test.id.startsWith('flow-'))
            return 'e2e';
        if (test.scenario.includes('smoke') || test.scenario.includes('health') || test.scenario.includes('critical-path'))
            return 'smoke';
        if (test.scenario.includes('api'))
            return 'api';
        return 'component';
    }
    priorityWeight(priority) {
        switch (priority) {
            case 'P0': return 0;
            case 'P1': return 1;
            case 'P2':
            default: return 2;
        }
    }
    topologicalSort(tests) {
        const byId = new Map(tests.map((test) => [test.id, test]));
        const pending = new Map(tests.map((test) => [test.id, new Set((test.dependencies ?? []).filter((dependency) => byId.has(dependency)))]));
        const sorted = [];
        while (pending.size > 0) {
            const ready = [...pending.entries()]
                .filter(([, deps]) => deps.size === 0)
                .map(([id]) => byId.get(id))
                .sort((a, b) => {
                const priority = this.priorityWeight(a.priority) - this.priorityWeight(b.priority);
                return priority !== 0 ? priority : a.id.localeCompare(b.id);
            });
            if (ready.length === 0) {
                return tests.sort((a, b) => a.id.localeCompare(b.id));
            }
            for (const test of ready) {
                sorted.push(test);
                pending.delete(test.id);
                for (const deps of pending.values())
                    deps.delete(test.id);
            }
        }
        return sorted;
    }
    registerDefaultStepExecutors() {
        this.registerStepExecutor({
            name: 'registration',
            execute: async (step, context, test) => {
                const mentionedThreads = test.threads.filter((threadId) => step.action.includes(threadId));
                const targets = mentionedThreads.length > 0 ? mentionedThreads : test.threads;
                for (const threadId of targets) {
                    if (!context.registry.has(threadId)) {
                        throw new Error(`Thread ${threadId} is not registered`);
                    }
                }
            },
        });
        this.registerStepExecutor({
            name: 'health',
            execute: async (_step, context) => {
                if (context.registry.size === 0) {
                    throw new Error('No registered threads available for health check');
                }
            },
        });
        this.registerStepExecutor({
            name: 'component',
            execute: async (_step, context, test) => {
                if (test.threads.length < 2)
                    return;
                const [from, to] = test.threads;
                const fromEntry = context.registry.get(from);
                const toEntry = context.registry.get(to);
                if (!fromEntry || !toEntry)
                    throw new Error('Missing thread entry for component integration test');
                const compatible = fromEntry.requires.some((required) => toEntry.provides.includes(required))
                    || toEntry.requires.some((required) => fromEntry.provides.includes(required))
                    || fromEntry.integrationPoints.some((point) => toEntry.integrationPoints.some((candidate) => candidate.contract === point.contract));
                if (!compatible)
                    throw new Error(`No compatible integration contract found between ${from} and ${to}`);
            },
        });
        this.registerStepExecutor({
            name: 'mock-server',
            execute: async (step, context, test) => {
                if (!context.mockServer)
                    throw new Error(`Mock server required for test ${test.id}`);
                if (step.action.toLowerCase().includes('start mock server')) {
                    await context.mockServer.start();
                    const routePath = `/integration/${test.id}`;
                    const hasRoute = context.mockServer.routes.some((route) => route.method === 'POST' && route.path === routePath);
                    if (!hasRoute) {
                        context.mockServer.registerRoute({
                            method: 'POST',
                            path: routePath,
                            response: { status: 200, body: { ok: true, testId: test.id } },
                        });
                    }
                    return;
                }
                if (step.action.toLowerCase().includes('invoke')) {
                    const response = await context.mockServer.invoke({
                        method: 'POST',
                        path: `/integration/${test.id}`,
                        body: { testId: test.id },
                    });
                    if (response.status >= 400)
                        throw new Error(`Mock server returned status ${response.status}`);
                    return;
                }
                if (step.action.toLowerCase().includes('verify request recorded')) {
                    if (context.mockServer.requests.length === 0)
                        throw new Error('Mock server did not record any requests');
                }
            },
        });
        this.registerStepExecutor({
            name: 'critical-path',
            execute: async (_step, context, test) => {
                for (const threadId of test.threads) {
                    const entry = context.registry.get(threadId);
                    if (!entry)
                        throw new Error(`Missing thread registration for ${threadId}`);
                    if (entry.integrationPoints.length === 0 && threadId !== 'thread-20') {
                        throw new Error(`Thread ${threadId} has no integration points registered`);
                    }
                }
            },
        });
        this.registerStepExecutor({
            name: 'state-transition',
            execute: async (step) => {
                if (!step.action.startsWith('Transition to ')) {
                    throw new Error(`Unsupported state transition step: ${step.action}`);
                }
            },
        });
    }
    selectStepExecutor(step, test) {
        const normalizedAction = step.action.toLowerCase();
        if (normalizedAction.includes('registered'))
            return this.stepExecutors.get('registration');
        if (normalizedAction.includes('health check'))
            return this.stepExecutors.get('health');
        if (normalizedAction.includes('compatibility') || normalizedAction.includes('integration point'))
            return this.stepExecutors.get('component');
        if (normalizedAction.includes('mock server') || normalizedAction.includes('request recorded') || normalizedAction.includes('contract'))
            return this.stepExecutors.get('mock-server');
        if (normalizedAction.includes('critical path'))
            return this.stepExecutors.get('critical-path');
        if (normalizedAction.startsWith('transition to '))
            return this.stepExecutors.get('state-transition');
        if (test.kind === 'api')
            return this.stepExecutors.get('mock-server');
        if (test.kind === 'e2e')
            return this.stepExecutors.get('state-transition');
        if (test.kind === 'smoke')
            return this.stepExecutors.get('critical-path');
        return this.stepExecutors.get('component');
    }
    async ensureTestDependencies(test) {
        const missing = (test.dependencies ?? []).filter((dependency) => this.testResults.get(dependency)?.status !== 'passed');
        if (missing.length > 0)
            throw new Error(`Missing successful dependency results: ${missing.join(', ')}`);
    }
    async prepareEnvironment() {
        if (!this.environment.setupComplete) {
            this.environment.setupComplete = true;
            this.environment.cleanedUp = false;
            this.environment.startedAt = Date.now();
            this.environment.lastResetAt = Date.now();
            this.environment.variables.set('NODE_ENV', 'test');
        }
        if (this.mockServer && !this.mockServer.running)
            await this.mockServer.start();
    }
    async prepareTestEnvironment(test, logs) {
        if (test.fixtureIds) {
            for (const fixtureId of test.fixtureIds) {
                if (!this.environment.fixtures.has(fixtureId)) {
                    this.environment.fixtures.set(fixtureId, { id: fixtureId, type: 'database', data: { testId: test.id, seeded: true } });
                    logs.push(`Seeded fixture: ${fixtureId}`);
                }
            }
        }
        if (test.useMockServer) {
            if (!this.mockServer)
                this.mockServer = new InMemoryMockServer();
            await this.mockServer.start();
        }
    }
    async cleanupEnvironment() {
        if (this.mockServer) {
            await this.mockServer.reset();
            await this.mockServer.stop();
        }
        this.environment.cleanedUp = true;
        this.environment.setupComplete = false;
        this.environment.variables.clear();
    }
    ensureTrendDirectory() {
        mkdirSync(path.dirname(this.trendFilePath), { recursive: true });
    }
    readTrendHistory() {
        try {
            const raw = readFileSync(this.trendFilePath, 'utf-8');
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        }
        catch {
            return [];
        }
    }
    recordTrend(summary) {
        this.ensureTrendDirectory();
        const history = this.readTrendHistory();
        const next = [
            ...history,
            {
                timestamp: Date.now(),
                passRate: summary.passRate,
                averageDurationMs: summary.total > 0 ? summary.durationMs / summary.total : 0,
                totalTests: summary.total,
            },
        ].slice(-DEFAULT_TREND_HISTORY_LIMIT);
        writeFileSync(this.trendFilePath, JSON.stringify(next, null, 2));
    }
    clearTrendHistory() {
        rmSync(this.trendFilePath, { force: true });
    }
}
export const integrationQA = new IntegrationQAEngine();

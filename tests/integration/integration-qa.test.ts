import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InMemoryMockServer, IntegrationQAEngine } from '../../src/core/integration-qa.js';
import type { IntegrationRegistryEntry } from '../../src/types/integration-qa.js';

function createTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createEntry(threadId: IntegrationRegistryEntry['threadId'], options: Partial<IntegrationRegistryEntry> = {}): IntegrationRegistryEntry {
  return {
    threadId,
    provides: options.provides ?? [],
    requires: options.requires ?? [],
    integrationPoints: options.integrationPoints ?? [],
  };
}

test('runs component, api, and e2e integration suite with orchestration and reporting', async () => {
  const rootDir = createTempDir('jackcode-integration-qa-');
  const mockServer = new InMemoryMockServer();
  const engine = new IntegrationQAEngine(
    { parallel: true, maxConcurrency: 3, retries: 1, defaultTimeoutMs: 2_000 },
    { rootDir, mockServer, trendFilePath: path.join(rootDir, '.jackcode', 'qa-trends.json') }
  );

  engine.registerThread(createEntry('thread-01', {
    provides: ['runtime-events', 'session-state'],
    requires: ['node-events'],
    integrationPoints: [{ name: 'runtime.execute', contract: 'runtime-events', handler: 'execute', async: true }],
  }));
  engine.registerThread(createEntry('thread-02', {
    provides: ['session-state'],
    requires: ['runtime-events'],
    integrationPoints: [{ name: 'session.sync', contract: 'session-state', handler: 'sync', async: true }],
  }));
  engine.registerThread(createEntry('thread-09', {
    provides: ['qwen-route'],
    requires: ['runtime-events'],
    integrationPoints: [{ name: 'qwen.route', contract: 'runtime-events', handler: 'route', async: true }],
  }));
  engine.registerThread(createEntry('thread-10', {
    provides: ['repair-route'],
    requires: ['runtime-events'],
    integrationPoints: [{ name: 'repair.route', contract: 'runtime-events', handler: 'repair', async: true }],
  }));
  engine.registerThread(createEntry('thread-11', {
    provides: ['review-route'],
    requires: ['runtime-events'],
    integrationPoints: [{ name: 'review.route', contract: 'runtime-events', handler: 'review', async: true }],
  }));
  engine.registerThread(createEntry('thread-03', {
    provides: ['patch-output'],
    requires: ['test-runner'],
    integrationPoints: [{ name: 'patch.emit', contract: 'test-runner', handler: 'emit', async: true }],
  }));
  engine.registerThread(createEntry('thread-04', {
    provides: ['test-runner'],
    requires: ['review-route'],
    integrationPoints: [{ name: 'test.run', contract: 'test-runner', handler: 'run', async: true }],
  }));
  engine.registerThread(createEntry('thread-13', {
    provides: ['node-events'],
    requires: ['runtime-events'],
    integrationPoints: [{ name: 'node.emit', contract: 'node-events', handler: 'emit', async: true }],
  }));
  engine.registerThread(createEntry('thread-20', {
    provides: ['integration-qa'],
    requires: [],
    integrationPoints: [{ name: 'qa.run', contract: 'integration-qa', handler: 'run', async: true }],
  }));

  const plan = engine.createOrchestrationPlan({ includeKinds: ['component', 'api', 'e2e'], priorities: ['P0', 'P1'] });
  assert.ok(plan.orderedTests.length > 0);
  assert.equal(plan.mode, 'parallel');
  assert.ok(plan.dependencyGraph.some((entry) => entry.dependsOn.length > 0));

  const suite = await engine.runTestSuite({ includeKinds: ['component', 'api', 'e2e'], priorities: ['P0', 'P1'] });

  assert.ok(suite.results.length > 0);
  assert.equal(suite.summary.failed, 0);
  assert.ok(suite.results.some((result) => result.testId.includes('-api')));
  assert.ok(suite.results.some((result) => result.testId.startsWith('flow-')));

  const report = engine.generateTestReport(suite.results);
  assert.ok(report.byKind.api > 0);
  assert.ok(report.byKind.component > 0);
  assert.ok(report.byKind.e2e > 0);

  const coverage = engine.generateCoverageReport();
  assert.equal(coverage.uncoveredPairs.length, 0);
  assert.equal(coverage.totals.pairCoverage, 1);

  const performance = engine.generatePerformanceReport(suite.results);
  assert.ok(performance.totalDurationMs >= 0);
  assert.ok(performance.slowestTests.length > 0);

  const trends = engine.generateTrendAnalysis();
  assert.ok(trends.history.length >= 1);

  const release = await engine.validateRelease('P1');
  assert.equal(release.passed, true);
  assert.equal(release.blockers.length, 0);

  rmSync(rootDir, { recursive: true, force: true });
});

test('enforces dependency sequencing for custom integration tests', async () => {
  const rootDir = createTempDir('jackcode-integration-qa-deps-');
  const engine = new IntegrationQAEngine(
    { parallel: true, maxConcurrency: 4, retries: 0 },
    { rootDir, trendFilePath: path.join(rootDir, '.jackcode', 'deps-trends.json') }
  );

  engine.registerThread(createEntry('thread-01', {
    provides: ['alpha'],
    requires: ['beta'],
    integrationPoints: [{ name: 'a', contract: 'alpha', handler: 'a', async: true }],
  }));
  engine.registerThread(createEntry('thread-02', {
    provides: ['beta'],
    requires: ['alpha'],
    integrationPoints: [{ name: 'b', contract: 'beta', handler: 'b', async: true }],
  }));
  engine.registerThread(createEntry('thread-20', {
    provides: ['integration-qa'],
    requires: [],
    integrationPoints: [{ name: 'qa', contract: 'integration-qa', handler: 'qa', async: true }],
  }));

  engine.registerTest({
    id: 'custom-component',
    name: 'Custom component',
    description: 'base dependency',
    threads: ['thread-01', 'thread-02'],
    priority: 'P0',
    scenario: 'custom-component',
    kind: 'component',
    steps: [
      { order: 1, action: 'Verify thread-01 is registered', verification: 'registered' },
      { order: 2, action: 'Verify thread-02 is registered', verification: 'registered' },
      { order: 3, action: 'Validate thread-01 requires/provides compatibility with thread-02', verification: 'compatible' },
    ],
    timeoutMs: 1_000,
  });

  engine.registerTest({
    id: 'custom-smoke',
    name: 'Custom smoke',
    description: 'depends on component test',
    threads: ['thread-01', 'thread-02'],
    priority: 'P0',
    scenario: 'custom-smoke',
    kind: 'smoke',
    dependencies: ['custom-component'],
    steps: [
      { order: 1, action: 'Run health check', verification: 'healthy' },
      { order: 2, action: 'Validate critical path', verification: 'critical path ready' },
    ],
    timeoutMs: 1_000,
  });

  const suite = await engine.runTestSuite({ includeKinds: ['component', 'smoke'], priorities: ['P0'] });
  const component = suite.results.find((result) => result.testId === 'custom-component');
  const smoke = suite.results.find((result) => result.testId === 'custom-smoke');

  assert.ok(component);
  assert.ok(smoke);
  assert.ok(component!.endedAt <= smoke!.endedAt);

  rmSync(rootDir, { recursive: true, force: true });
});

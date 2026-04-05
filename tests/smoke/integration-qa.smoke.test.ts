import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { InMemoryMockServer, IntegrationQAEngine } from '../../src/core/integration-qa.ts';
import type { IntegrationRegistryEntry } from '../../src/types/integration-qa.ts';

function createTempDir(prefix: string): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

function registerCriticalThreads(engine: IntegrationQAEngine): void {
  const entries: IntegrationRegistryEntry[] = [
    {
      threadId: 'thread-01',
      provides: ['runtime-events', 'session-state'],
      requires: ['node-events'],
      integrationPoints: [{ name: 'runtime.execute', contract: 'runtime-events', handler: 'execute', async: true }],
    },
    {
      threadId: 'thread-02',
      provides: ['session-state'],
      requires: ['runtime-events'],
      integrationPoints: [{ name: 'session.sync', contract: 'session-state', handler: 'sync', async: true }],
    },
    {
      threadId: 'thread-09',
      provides: ['qwen-route'],
      requires: ['runtime-events'],
      integrationPoints: [{ name: 'qwen.route', contract: 'runtime-events', handler: 'route', async: true }],
    },
    {
      threadId: 'thread-10',
      provides: ['repair-route'],
      requires: ['runtime-events'],
      integrationPoints: [{ name: 'repair.route', contract: 'runtime-events', handler: 'repair', async: true }],
    },
    {
      threadId: 'thread-11',
      provides: ['review-route'],
      requires: ['runtime-events'],
      integrationPoints: [{ name: 'review.route', contract: 'runtime-events', handler: 'review', async: true }],
    },
    {
      threadId: 'thread-03',
      provides: ['patch-output'],
      requires: ['test-runner'],
      integrationPoints: [{ name: 'patch.emit', contract: 'test-runner', handler: 'emit', async: true }],
    },
    {
      threadId: 'thread-04',
      provides: ['test-runner'],
      requires: ['review-route'],
      integrationPoints: [{ name: 'test.run', contract: 'test-runner', handler: 'run', async: true }],
    },
    {
      threadId: 'thread-13',
      provides: ['node-events'],
      requires: ['runtime-events'],
      integrationPoints: [{ name: 'node.emit', contract: 'node-events', handler: 'emit', async: true }],
    },
    {
      threadId: 'thread-20',
      provides: ['integration-qa'],
      requires: [],
      integrationPoints: [{ name: 'qa.run', contract: 'integration-qa', handler: 'run', async: true }],
    },
  ];

  for (const entry of entries) {
    engine.registerThread(entry);
  }
}

test('smoke tests validate health checks, critical path, and quick validation', async () => {
  const rootDir = createTempDir('jackcode-smoke-qa-');
  const engine = new IntegrationQAEngine(
    { parallel: true, maxConcurrency: 2, retries: 0, failFast: true },
    { rootDir, mockServer: new InMemoryMockServer(), trendFilePath: path.join(rootDir, '.jackcode', 'smoke-trends.json') }
  );

  registerCriticalThreads(engine);
  engine.configureEnvironment({ mode: 'smoke', quickValidation: true });

  const smoke = await engine.runSmokeTests({ parallel: true, filter: ['P0'] });
  assert.ok(smoke.results.length > 0);
  assert.equal(smoke.summary.failed, 0);
  assert.ok(smoke.results.every((result) => result.status === 'passed'));

  const env = engine.getEnvironmentState();
  assert.equal(env.setupComplete, true);
  assert.equal(env.config.mode, 'smoke');

  const matrix = await engine.generateQAMatrix();
  assert.ok(matrix.overallScore > 0);
  assert.ok(matrix.dimensions.some((dimension) => dimension.name === 'Functional' && dimension.coverage > 0));

  rmSync(rootDir, { recursive: true, force: true });
});

test('runPairTest exercises critical-path smoke subset for a thread pair', async () => {
  const rootDir = createTempDir('jackcode-smoke-pair-');
  const engine = new IntegrationQAEngine(
    { parallel: false, retries: 0 },
    { rootDir, mockServer: new InMemoryMockServer(), trendFilePath: path.join(rootDir, '.jackcode', 'pair-trends.json') }
  );

  registerCriticalThreads(engine);

  const results = await engine.runPairTest('thread-01', 'thread-02', { scenario: 'critical-path' });
  assert.ok(results.length >= 1);
  assert.ok(results.every((result) => result.status === 'passed'));

  const threadResults = engine.getResultsByThread('thread-01');
  assert.ok(threadResults.length >= results.length);

  rmSync(rootDir, { recursive: true, force: true });
});

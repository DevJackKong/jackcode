import assert from 'node:assert/strict';
import test from 'node:test';

import { ImpactAnalyzer } from './impact-analyzer.js';
import type { DependencyNode } from '../types/impact-analyzer.js';

const rootDir = '/repo';

function makeNode(
  path: string,
  options: Partial<DependencyNode> = {}
): DependencyNode {
  return {
    path,
    exports: [],
    imports: [],
    dependents: [],
    lastModified: Date.now(),
    ...options,
  };
}

test('analyze computes direct/transitive impact, symbol ripple, tests, and risk assessment', async () => {
  const analyzer = new ImpactAnalyzer({
    rootDir,
    includeTests: true,
    includeTypeDependencies: true,
    maxDepth: 5,
  });

  analyzer.updateNode(
    makeNode('/repo/src/core/a.ts', {
      exports: [{ name: 'foo', kind: 'function', isDefault: false, line: 1, isTypeOnly: false }],
      dependents: ['/repo/src/core/b.ts', '/repo/src/tests/a.test.ts'],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/core/b.ts', {
      imports: [{ name: 'foo', source: './a', kind: 'named', isTypeOnly: false }],
      exports: [{ name: 'bar', kind: 'function', isDefault: false, line: 1, isTypeOnly: false }],
      dependents: ['/repo/src/model/router.ts'],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/model/router.ts', {
      imports: [{ name: 'bar', source: '../core/b', kind: 'named', isTypeOnly: false }],
      dependents: ['/repo/src/e2e/router.e2e.test.ts'],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/tests/a.test.ts', {
      imports: [{ name: 'foo', source: '../core/a', kind: 'named', isTypeOnly: false }],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/e2e/router.e2e.test.ts', {
      imports: [{ name: 'bar', source: '../model/router', kind: 'named', isTypeOnly: false }],
    })
  );

  const report = await analyzer.analyze({
    path: 'src/core/a.ts',
    type: 'modify',
    scope: 'symbol',
    symbolName: 'foo',
  });

  assert.equal(report.summary.totalFilesImpacted, 5);
  assert.equal(report.summary.directImpacts, 1);
  assert.equal(report.summary.transitiveImpacts, 2);
  assert.equal(report.summary.scope, 'e2e');
  assert.equal(report.riskLevel, 'high');

  const impactedPaths = report.impactedFiles.map((file) => file.path);
  assert.deepEqual(impactedPaths, [
    '/repo/src/core/a.ts',
    '/repo/src/core/b.ts',
    '/repo/src/model/router.ts',
    '/repo/src/e2e/router.e2e.test.ts',
    '/repo/src/tests/a.test.ts',
  ]);

  const symbolImpact = report.symbolImpacts.find((item) => item.symbolName === 'foo');
  assert.ok(symbolImpact);
  assert.equal(symbolImpact?.compatibility, 'potentially-breaking');
  assert.equal(symbolImpact?.directReferenceCount, 2);
  assert.ok(symbolImpact?.rippleFiles.includes('/repo/src/model/router.ts'));

  assert.deepEqual(
    report.affectedTests.map((item) => item.path),
    ['/repo/src/e2e/router.e2e.test.ts', '/repo/src/tests/a.test.ts']
  );
  assert.deepEqual(
    report.testSelection.minimal.map((item) => item.path),
    ['/repo/src/e2e/router.e2e.test.ts', '/repo/src/tests/a.test.ts']
  );
  assert.ok(report.recommendations.some((item) => item.includes('minimal test set')));
  assert.ok(report.riskAssessment.criticalPaths.includes('/repo/src/model/router.ts'));
});

test('delete of shared symbol is marked as breaking and raises test priority', async () => {
  const analyzer = new ImpactAnalyzer({
    rootDir,
    includeTests: true,
    includeTypeDependencies: true,
    maxDepth: 4,
  });

  analyzer.updateNode(
    makeNode('/repo/src/api/contracts.ts', {
      exports: [{ name: 'Contract', kind: 'interface', isDefault: false, line: 1, isTypeOnly: false }],
      dependents: ['/repo/src/runtime/session.ts', '/repo/src/integration/contracts.integration.test.ts'],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/runtime/session.ts', {
      imports: [{ name: 'Contract', source: '../api/contracts', kind: 'named', isTypeOnly: false }],
      dependents: ['/repo/src/integration/contracts.integration.test.ts'],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/integration/contracts.integration.test.ts', {
      imports: [{ name: 'Contract', source: '../api/contracts', kind: 'named', isTypeOnly: false }],
    })
  );

  const report = await analyzer.analyze({
    path: 'src/api/contracts.ts',
    type: 'delete',
    scope: 'symbol',
    symbolName: 'Contract',
  });

  assert.equal(report.summary.breakingChanges, 1);
  assert.equal(report.riskLevel, 'high');
  assert.equal(report.symbolImpacts[0]?.compatibility, 'breaking');
  assert.equal(report.symbolImpacts[0]?.isBreakingChange, true);
  assert.equal(report.affectedTests[0]?.priority, 'critical');
  assert.ok(report.recommendations.some((item) => item.includes('API compatibility')));
});

test('type-only dependencies are downgraded or excluded based on options', async () => {
  const withTypes = new ImpactAnalyzer({
    rootDir,
    includeTests: false,
    includeTypeDependencies: true,
  });

  withTypes.updateNode(
    makeNode('/repo/src/types/shared.ts', {
      exports: [{ name: 'SharedType', kind: 'type', isDefault: false, line: 1, isTypeOnly: true }],
      dependents: ['/repo/src/core/consumer.ts'],
    })
  );

  withTypes.updateNode(
    makeNode('/repo/src/core/consumer.ts', {
      imports: [{ name: 'SharedType', source: '../types/shared', kind: 'named', isTypeOnly: true }],
    })
  );

  const includeReport = await withTypes.analyze({
    path: 'src/types/shared.ts',
    type: 'modify',
    scope: 'symbol',
    symbolName: 'SharedType',
  });

  const typedConsumer = includeReport.impactedFiles.find((file) => file.path === '/repo/src/core/consumer.ts');
  assert.equal(typedConsumer?.category, 'type-only');
  assert.equal(typedConsumer?.severity, 'low');

  const withoutTypes = new ImpactAnalyzer({
    rootDir,
    includeTests: false,
    includeTypeDependencies: false,
  });

  withoutTypes.updateNode(
    makeNode('/repo/src/types/shared.ts', {
      exports: [{ name: 'SharedType', kind: 'type', isDefault: false, line: 1, isTypeOnly: true }],
      dependents: ['/repo/src/core/consumer.ts'],
    })
  );

  withoutTypes.updateNode(
    makeNode('/repo/src/core/consumer.ts', {
      imports: [{ name: 'SharedType', source: '../types/shared', kind: 'named', isTypeOnly: true }],
    })
  );

  const excludeReport = await withoutTypes.analyze({
    path: 'src/types/shared.ts',
    type: 'modify',
    scope: 'symbol',
    symbolName: 'SharedType',
  });

  assert.equal(
    excludeReport.impactedFiles.some((file) => file.path === '/repo/src/core/consumer.ts'),
    false
  );
});

test('rename tracks previous path and detects minimal test set coverage', async () => {
  const analyzer = new ImpactAnalyzer({
    rootDir,
    includeTests: true,
    includeTypeDependencies: true,
  });

  analyzer.updateNode(
    makeNode('/repo/src/tools/test-runner.ts', {
      exports: [{ name: 'runTests', kind: 'function', isDefault: false, line: 1, isTypeOnly: false }],
      dependents: ['/repo/src/cli/index.ts', '/repo/src/tools/test-runner.spec.ts'],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/cli/index.ts', {
      imports: [{ name: 'runTests', source: '../tools/test-runner', kind: 'named', isTypeOnly: false }],
      dependents: ['/repo/src/e2e/cli.e2e.test.ts'],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/tools/test-runner.spec.ts', {
      imports: [{ name: 'runTests', source: './test-runner', kind: 'named', isTypeOnly: false }],
    })
  );

  analyzer.updateNode(
    makeNode('/repo/src/e2e/cli.e2e.test.ts', {
      imports: [{ name: 'main', source: '../cli/index', kind: 'named', isTypeOnly: false }],
    })
  );

  const report = await analyzer.analyze({
    path: 'src/tools/test-runner.ts',
    previousPath: 'src/tools/runner.ts',
    type: 'rename',
    scope: 'file',
  });

  assert.ok(report.impactedFiles.some((file) => file.path === '/repo/src/tools/runner.ts'));
  assert.deepEqual(
    report.testSelection.minimal.map((item) => item.path),
    ['/repo/src/e2e/cli.e2e.test.ts', '/repo/src/tools/test-runner.spec.ts']
  );
  assert.equal(report.summary.severity, 'critical');
});

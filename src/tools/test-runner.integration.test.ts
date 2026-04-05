import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BuildTestLoopOrchestrator, TestRunner, type CommandExecutor, type CommandSpec } from './test-runner.js';

function createProject(structure: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'jackcode-thread-04-int-'));
  for (const [file, content] of Object.entries(structure)) {
    const full = join(root, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function createExecutor(handler: (spec: CommandSpec) => { stdout?: string; stderr?: string } | Promise<{ stdout?: string; stderr?: string }>): CommandExecutor {
  return async (spec) => handler(spec);
}

function createScannerStub(testFiles: string[]) {
  return {
    getIndex() {
      return {
        files: new Map(testFiles.map((file) => [file, { path: file, isTest: true }]))
      };
    },
  };
}

function createImpactStub(selectedTests: string[]) {
  return {
    async analyze() {
      return {
        affectedTests: selectedTests.map((path) => ({ path })),
      };
    },
  };
}

function createSessionStub() {
  const history: Array<{ coverage?: { lines: number; functions: number; branches: number; statements: number } }> = [];
  const notes: string[] = [];
  return {
    id: 'session-1',
    taskId: 'task-1',
    recordTestResult(_sessionId: string, result: { coverage?: { lines: number; functions: number; branches: number; statements: number } }) {
      history.push({ coverage: result.coverage });
      return true;
    },
    addTaskNote(_sessionId: string, _taskId: string, note: string) {
      notes.push(note);
      return true;
    },
    getTestCoverage() {
      const current = [...history].reverse().find((entry) => entry.coverage)?.coverage ?? null;
      return { current, trend: current ? 'flat' : 'unknown', historyLength: history.length };
    },
    notes,
  };
}

test('stores build/test results in session and exposes coverage trend', async () => {
  const root = createProject({
    'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }),
    'src/foo.ts': 'export const foo = 1;\n',
    'src/foo.test.js': 'import test from "node:test"; test("x",()=>{});\n',
    'node_modules/.bin/vitest': '',
  });

  try {
    const session = createSessionStub();
    const scanner = createScannerStub(['src/foo.test.ts']);
    const impact = createImpactStub(['src/foo.test.ts']);

    const completed: string[] = [];
    const runner = new TestRunner(
      undefined,
      createExecutor(async () => ({ stdout: 'Lines : 92%\nFunctions : 90%\nBranches : 80%\nStatements : 91%' })),
      { session: session as never, sessionId: session.id, taskId: session.taskId, scanner, impactAnalyzer: impact }
    );
    runner.onComplete((event) => completed.push(event.trigger));

    const result = await runner.runAffectedTests(['src/foo.ts']);
    assert.equal(result.success, true);
    assert.deepEqual(completed, ['affected']);

    const coverage = session.getTestCoverage();
    assert.equal(coverage?.current?.lines, 92);
    assert.equal(coverage?.trend, 'flat');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('build to test report workflow runs through orchestrator with affected test selection', async () => {
  const root = createProject({
    'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }),
    'src/runtime.ts': 'export const runtime = true;\n',
    'src/runtime.integration.test.js': 'import test from "node:test"; test("x",()=>{});\n',
    'node_modules/.bin/vitest': '',
    'node_modules/.bin/tsc': '',
    'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
  });

  try {
    const session = createSessionStub();
    const scanner = createScannerStub(['src/runtime.integration.test.ts']);
    const impact = createImpactStub(['src/runtime.integration.test.ts']);

    const labels: string[] = [];
    const orchestrator = new BuildTestLoopOrchestrator(
      {
        rootDir: root,
        retryAttempts: 0,
        integrations: { session: session as never, sessionId: session.id, taskId: session.taskId, scanner, impactAnalyzer: impact },
      },
      undefined,
      createExecutor(async (spec) => {
        labels.push(spec.label ?? spec.command);
        if ((spec.label ?? '').includes('tsc-build')) {
          return { stdout: 'compiled' };
        }
        if ((spec.label ?? '').includes('vitest')) {
          return { stdout: 'Lines : 96%\nFunctions : 95%\nBranches : 89%\nStatements : 97%' };
        }
        return { stdout: 'ok' };
      })
    );

    const result = await orchestrator.run({ incremental: true });
    assert.equal(result.success, true);
    assert.ok(labels.includes('tsc-build'));
    assert.ok(labels.includes('vitest'));
    assert.equal(session.getTestCoverage()?.current?.lines, 96);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

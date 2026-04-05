import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BuildRunner,
  BuildTestLoopOrchestrator,
  CoverageTracker,
  Linter,
  ProjectEnvironment,
  TestRunner,
  checkCoverageThresholds,
  classifyFailure,
  parseCoverageFromText,
  type CommandExecutor,
  type CommandSpec,
} from './test-runner.ts';

function createProject(structure: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'jackcode-thread-04-'));
  for (const [file, content] of Object.entries(structure)) {
    const full = join(root, file);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function withProject<T>(structure: Record<string, string>, fn: (root: string) => Promise<T> | T): Promise<T> {
  const root = createProject(structure);
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}

function createExecutor(handler: (spec: CommandSpec) => { stdout?: string; stderr?: string } | Promise<{ stdout?: string; stderr?: string }>): CommandExecutor {
  return async (spec) => handler(spec);
}

test('ProjectEnvironment detects package manager and scripts', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({ scripts: { build: 'tsc -b', lint: 'eslint src', format: 'prettier --write .' } }),
      'pnpm-lock.yaml': 'lockfileVersion: 9',
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
    },
    (root) => {
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const config = env.discoverBuildConfig();

      assert.equal(env.detectPackageManager(), 'pnpm');
      assert.equal(config.buildScript, 'tsc -b');
      assert.ok(config.tsconfigPath?.endsWith('tsconfig.json'));
    }
  );
});

test('BuildRunner prefers package build script', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({ scripts: { build: 'tsc -b' } }),
      'yarn.lock': '',
    },
    async (root) => {
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const runner = new BuildRunner(env, createExecutor(async (spec) => {
        assert.equal(spec.command, 'yarn');
        assert.deepEqual(spec.args, ['run', 'build']);
        return { stdout: 'ok' };
      }));

      const result = await runner.compile();
      assert.equal(result.success, true);
      assert.equal(result.command?.command, 'yarn');
    }
  );
});

test('BuildRunner falls back to tsc with incremental flag', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({}),
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
      'node_modules/.bin/tsc': '',
    },
    async (root) => {
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const runner = new BuildRunner(env, createExecutor(async (spec) => {
        assert.ok(spec.args.includes('--incremental'));
        assert.ok(spec.args.includes('--project'));
        return { stdout: 'compiled' };
      }));

      const result = await runner.compile({ incremental: true });
      assert.equal(result.success, true);
      assert.equal(result.command?.label, 'tsc-build');
    }
  );
});

test('TestRunner detects vitest and builds coverage command', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }),
      'node_modules/.bin/vitest': '',
    },
    async (root) => {
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const runner = new TestRunner(env, createExecutor(async (spec) => {
        assert.equal(spec.label, 'vitest');
        assert.ok(spec.args.includes('--coverage'));
        return {
          stdout: 'Lines : 91%\nFunctions : 92%\nBranches : 70%\nStatements : 90%',
        };
      }));

      const result = await runner.run({ coverage: true, parallel: 2 }, { lines: 90, branches: 60 });
      assert.equal(runner.detectTestRunner(), 'vitest');
      assert.equal(result.success, true);
      assert.equal(result.coverage?.lines, 91);
    }
  );
});

test('TestRunner detects mocha', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({ devDependencies: { mocha: '^10.0.0' } }),
      '.mocharc.json': JSON.stringify({ spec: 'test/**/*.spec.js' }),
    },
    (root) => {
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const runner = new TestRunner(env, createExecutor(async () => ({ stdout: 'ok' })));
      assert.equal(runner.detectTestRunner(), 'mocha');
    }
  );
});

test('parseCoverageFromText and thresholds work', () => {
  const coverage = parseCoverageFromText('Lines : 85%\nFunctions : 88%\nBranches : 80%\nStatements : 90%');
  assert.deepEqual(coverage, {
    lines: 85,
    functions: 88,
    branches: 80,
    statements: 90,
  });

  assert.deepEqual(checkCoverageThresholds(coverage!, { lines: 90, branches: 75 }), [
    'Coverage threshold failed for lines: 85% < 90%',
  ]);
});

test('CoverageTracker prefers coverage-summary.json and records trends', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({}),
      'coverage/coverage-summary.json': JSON.stringify({
        total: {
          lines: { pct: 93 },
          functions: { pct: 94 },
          branches: { pct: 81 },
          statements: { pct: 92 },
        },
      }),
    },
    (root) => {
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const tracker = new CoverageTracker(env);
      const report = tracker.parseCoverage('ignored text');
      assert.deepEqual(report, {
        lines: 93,
        functions: 94,
        branches: 81,
        statements: 92,
      });

      const history = tracker.record(report!);
      assert.equal(history.length, 1);
      assert.equal(tracker.latestTrend()?.lines, 93);
    }
  );
});

test('Linter uses custom scripts and supports auto-fix', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({ scripts: { lint: 'eslint src', format: 'prettier --write .' } }),
    },
    async (root) => {
      const commands: string[] = [];
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const linter = new Linter(env, createExecutor(async (spec) => {
        commands.push(`${spec.command} ${spec.args.join(' ')}`);
        return { stdout: 'ok' };
      }));

      const result = await linter.lint({ fix: true, format: true });
      assert.equal(result.success, true);
      assert.equal(commands[0], 'npm run lint -- --fix');
      assert.equal(commands[1], 'npm run format');
    }
  );
});

test('classifyFailure identifies major categories', () => {
  assert.equal(classifyFailure('ESLint found 3 problems', []), 'lint');
  assert.equal(classifyFailure('Coverage threshold failed for lines', []), 'coverage');
  assert.equal(classifyFailure('Jest: 2 failing tests', []), 'test');
  assert.equal(classifyFailure('tsc compile error', []), 'build');
  assert.equal(classifyFailure('ENOENT command not found', []), 'environment');
});

test('BuildTestLoopOrchestrator performs pre/post verification and retries transient failures', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }),
      'node_modules/.bin/vitest': '',
      'tsconfig.json': JSON.stringify({ compilerOptions: { target: 'ES2022' } }),
    },
    async (root) => {
      let buildAttempts = 0;
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const executor = createExecutor(async (spec) => {
        if (spec.label === 'vitest') {
          return { stdout: 'Lines : 95%\nFunctions : 94%\nBranches : 88%\nStatements : 96%' };
        }
        if (spec.label === 'tsc-build') {
          buildAttempts += 1;
          if (buildAttempts === 1) {
            const error = new Error('Command failed: tsc');
            (error as Error & { stderr?: string }).stderr = 'ENOENT temporary tool lookup failure';
            throw error;
          }
          return { stdout: 'compiled' };
        }
        if (spec.label === 'eslint' || spec.label === 'prettier') {
          return { stdout: 'ok' };
        }
        return { stdout: 'ok' };
      });

      const orchestrator = new BuildTestLoopOrchestrator(
        { rootDir: root, retryAttempts: 1, retryDelayMs: 0, coverageThresholds: { lines: 90 } },
        env,
        executor
      );

      const result = await orchestrator.run({ incremental: true });
      assert.equal(result.success, true);
      assert.equal(result.prePatchPassed, true);
      assert.equal(result.postPatchPassed, true);
      assert.equal(result.retries, 1);
      assert.ok(result.stages.length >= 5);
    }
  );
});

test('BuildTestLoopOrchestrator fails fast when pre-patch verification fails', async () => {
  await withProject(
    {
      'package.json': JSON.stringify({ devDependencies: { jest: '^29.0.0' } }),
    },
    async (root) => {
      const env = new ProjectEnvironment(root, '.jackcode/cache');
      const orchestrator = new BuildTestLoopOrchestrator(
        { rootDir: root, retryAttempts: 0 },
        env,
        createExecutor(async (spec) => {
          if (spec.label === 'jest') {
            const error = new Error('Jest failed');
            (error as Error & { stdout?: string }).stdout = 'Jest: 4 failing tests';
            throw error;
          }
          return { stdout: 'ok' };
        })
      );

      const result = await orchestrator.run();
      assert.equal(result.success, false);
      assert.equal(result.prePatchPassed, false);
      assert.equal(result.stages.length, 1);
      assert.equal(result.classification, 'test');
    }
  );
});

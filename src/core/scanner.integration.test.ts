import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// @ts-nocheck
import { RepoScanner } from './scanner.js';
import { SessionManager } from './session.js';
import { RuntimeStateMachine } from './runtime.js';
import { buildPatchFromRequest, applyPatch } from '../tools/patch.js';

function makeRepo(name: string): string {
  return mkdtempSync(join(tmpdir(), `jackcode-scanner-int-${name}-`));
}

function write(root: string, file: string, content: string): void {
  mkdirSync(join(root, file.split('/').slice(0, -1).join('/')), { recursive: true });
  writeFileSync(join(root, file), content, 'utf8');
}

test('scanner integrates with runtime, session, patch engine, and git workflow', async () => {
  const root = makeRepo('workflow');
  try {
    write(root, 'package.json', JSON.stringify({ scripts: { build: 'tsc', test: 'node --test' }, devDependencies: { vitest: '^2.0.0' } }, null, 2));
    write(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { target: 'ES2022' } }, null, 2));
    write(root, 'vitest.config.js', 'export default {}\n');
    write(root, 'src/app.js', 'export const value = 1;\n');
    write(root, 'src/app.test.js', 'import { value } from "./app";\nconsole.log(value);\n');

    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Jack Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'jack@example.com'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });

    const scanner = new RepoScanner({ rootDir: root });
    const scan = await scanner.scan();
    assert.equal(scan.success, true);
    assert.equal(scanner.getTestFiles('src/app.js')[0], 'src/app.test.js');
    const gitBefore = await scanner.getGitStatus();
    assert.equal(gitBefore.hasChanges, false);

    const sessionManager = new SessionManager();
    const session = sessionManager.createSession({ rootGoal: 'Integrate scanner' });

    const runtime = new RuntimeStateMachine({
      session: sessionManager,
      scanner,
      executor: {
        execute: async () => ({ success: true }),
        review: async () => ({ approved: true }),
      },
    }, { autoPersist: false });

    runtime.createTask('touch repo', { id: 'task-1', sessionId: session.id });
    runtime.setPlan('task-1', {
      estimatedTokens: 100,
      targetModel: 'qwen',
      steps: [{ id: 'step-1', description: 'update app', targetFiles: ['src/app.js'], dependencies: [] }],
    });

    // runtime.watchRepo() was removed; repo scanning is exercised via runTask()
    await runtime.runTask('task-1');
    assert.ok(sessionManager.getScannerSnapshot(session.id));

    const patch = await buildPatchFromRequest({
      targetPath: join(root, 'src/app.js'),
      description: 'update exported value',
      range: { start: 1, end: 1 },
      replacement: 'export const value = 2;\n',
    });

    const patchResult = await applyPatch({
      id: 'plan-1',
      createdAt: Date.now(),
      patches: [patch],
      impact: { filesAffected: 1, linesAdded: 1, linesRemoved: 1, riskLevel: 'low' },
    }, session.id, scanner);
    assert.equal(patchResult.success, true);

    await scanner.scanIncremental([{ path: 'src/app.js', type: 'modified' }]);
    sessionManager.recordFileChanges(session.id, [{ path: 'src/app.js', type: 'modified' }]);
    assert.equal(sessionManager.getChangedFiles(session.id).some((f) => f.path === 'src/app.js'), true);

    const gitAfter = await scanner.getGitStatus();
    assert.equal(gitAfter.modified.includes('src/app.js') || gitAfter.staged.includes('src/app.js'), true);

    const stashed = await scanner.stashChanges('integration-test');
    assert.equal(stashed, true);
    const afterStash = await scanner.getGitStatus();
    assert.equal(afterStash.hasChanges, false);
    const restored = await scanner.restoreStash();
    assert.equal(restored, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

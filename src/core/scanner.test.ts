import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';
import test from 'node:test';
import assert from 'node:assert/strict';

import { DependencyParser, LanguageDetector, RepoScanner } from './scanner.ts';

function makeTempRepo(name: string): string {
  const root = join(tmpdir(), `jackcode-scanner-${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  return root;
}

function write(root: string, file: string, content: string): void {
  const dir = join(root, file.split('/').slice(0, -1).join('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(root, file), content);
}

test('LanguageDetector detects extension, shebang, and content patterns', () => {
  const detector = new LanguageDetector();
  assert.equal(detector.detect('src/app.ts').language, 'typescript');
  assert.equal(detector.detect('Dockerfile').language, 'docker');
  assert.equal(detector.detect('scripts/run', '#!/usr/bin/env python\nprint(1)').language, 'python');
  assert.equal(detector.detect('unknown.txt', '{"ok":true}').language, 'json');
});

test('DependencyParser parses package.json and requirements.txt', () => {
  const parser = new DependencyParser();
  const pkgDeps = parser.parsePackageJson(JSON.stringify({
    dependencies: { react: '^18.0.0' },
    devDependencies: { vitest: '^2.0.0' },
  }), 'package.json');
  assert.equal(pkgDeps.length, 2);
  assert.equal(pkgDeps[0]?.name, 'react');

  const pyDeps = parser.parseRequirementsTxt('fastapi>=0.110\nuvicorn==0.30\n', 'requirements.txt');
  assert.equal(pyDeps.length, 2);
  assert.equal(pyDeps[0]?.name, 'fastapi');
});

test('RepoScanner scans repo, detects frameworks, dependencies, and import graph', async () => {
  const root = makeTempRepo('scan');
  try {
    write(root, '.gitignore', 'ignored.txt\nnode_modules\n');
    write(root, 'package.json', JSON.stringify({
      dependencies: { react: '^18.2.0', express: '^4.19.0' },
      devDependencies: { vitest: '^2.0.0' },
    }, null, 2));
    write(root, 'src/index.ts', "import { helper } from './util';\nimport React from 'react';\nexport const value = helper();\n");
    write(root, 'src/util.ts', 'export const helper = () => 42;\n');
    write(root, 'src/index.test.ts', 'import { value } from "./index";\nconsole.log(value);\n');
    write(root, 'vite.config.ts', 'export default {};\n');
    write(root, 'ignored.txt', 'ignore me');

    const scanner = new RepoScanner({ rootDir: root, exclude: ['dist'] });
    const result = await scanner.scan();

    assert.equal(result.success, true);
    assert.ok(result.index);
    assert.equal(result.index?.files.has('ignored.txt'), false);
    assert.equal(result.index?.files.has('src/index.ts'), true);

    const indexFile = scanner.getFile('src/index.ts') as Record<string, unknown>;
    assert.equal(indexFile.language, 'typescript');
    assert.deepEqual(indexFile.frameworks, ['react']);

    const testFile = scanner.getFile('src/index.test.ts') as Record<string, unknown>;
    assert.equal(testFile.isTest, true);

    const configFile = scanner.getFile('vite.config.ts') as Record<string, unknown>;
    assert.equal(configFile.isConfig, true);

    const frameworks = scanner.getFrameworks();
    assert.ok(frameworks.includes('express'));
    assert.ok(frameworks.includes('react'));
    assert.ok(frameworks.includes('vitest'));

    const dependencies = scanner.getDependencies() as Array<Record<string, unknown>>;
    assert.ok(dependencies.some((dep) => dep.name === 'react'));
    assert.ok(dependencies.some((dep) => dep.name === 'vitest'));

    const importGraph = scanner.getImportGraph();
    assert.deepEqual(importGraph.get('src/index.ts'), ['src/util.ts']);

    const benchmark = scanner.getBenchmark();
    assert.ok(benchmark);
    assert.ok((benchmark?.fileCount || 0) >= 4);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RepoScanner supports incremental scans and circular dependency detection', async () => {
  const root = makeTempRepo('incremental');
  try {
    write(root, 'src/a.ts', "import { b } from './b';\nexport const a = b;\n");
    write(root, 'src/b.ts', "import { a } from './a';\nexport const b = a;\n");

    const scanner = new RepoScanner({ rootDir: root });
    await scanner.scan();
    const cycles = scanner.getCircularDependencies();
    assert.equal(cycles.length, 1);

    write(root, 'src/b.ts', 'export const b = 1;\n');
    await scanner.scanIncremental([{ path: 'src/b.ts', type: 'modified' }]);
    assert.equal(scanner.getCircularDependencies().length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RepoScanner git integration returns branch, changes, history and blame', async () => {
  const root = makeTempRepo('git');
  try {
    write(root, 'src/app.ts', 'export const app = 1;\n');
    execFileSync('git', ['init'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Jack Test'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'jack@example.com'], { cwd: root });
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root });
    write(root, 'src/app.ts', 'export const app = 2;\n');

    const scanner = new RepoScanner({ rootDir: root });
    const result = await scanner.scan();
    assert.equal(result.index?.gitInfo?.isRepo, true);
    assert.ok(result.index?.gitInfo?.currentBranch);
    assert.ok(['modified', 'staged'].includes(scanner.getFile('src/app.ts')?.gitStatus || ''));

    const history = await scanner.getFileHistory('src/app.ts', 5);
    assert.equal(history.commits.length >= 1, true);

    const blame = await scanner.getBlameInfo('src/app.ts');
    assert.ok(blame?.authors.includes('Jack Test') || blame?.authors.includes('Not Committed Yet'));

    const changes = await scanner.detectChangesSince('HEAD');
    assert.ok(changes.some((change) => change.path === 'src/app.ts' && change.type === 'modified'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('RepoScanner filtering supports regex, size and age constraints', async () => {
  const root = makeTempRepo('filters');
  try {
    write(root, 'src/keep.ts', 'export const keep = true;\n');
    write(root, 'src/skip.log', 'x'.repeat(2048));

    const scanner = new RepoScanner({ rootDir: root, maxFileSize: 1024 * 1024 });
    const result = await scanner.scan({
      ignoreRegex: [/\.log$/],
      maxSize: 100,
      customFilter: (_abs, rel) => rel !== 'src/filtered.ts',
    });

    assert.equal(result.index?.files.has('src/keep.ts'), true);
    assert.equal(result.index?.files.has('src/skip.log'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

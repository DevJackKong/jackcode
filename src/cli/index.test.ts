import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { parseArgs } from './index.js';

const CLI_ENTRY = fileURLToPath(new URL('./index.ts', import.meta.url));
const CLI_ROOT = dirname(dirname(CLI_ENTRY));
const TSX_CLI = join(CLI_ROOT, '..', 'node_modules', 'tsx', 'dist', 'cli.mjs');

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'jackcode-cli-'));
}

function runCli(args: string[], cwd: string) {
  return spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd,
    encoding: 'utf8',
    env: process.env,
  });
}

test('parseArgs recognizes approval and verification flags', () => {
  const parsed = parseArgs(['--execute', '--approve', '--verify-cmd', 'npm test', 'update src/index.ts']);
  assert.equal(parsed.mode, 'execute');
  assert.equal(parsed.flags.approve, true);
  assert.equal(parsed.flags.verifyCmd, 'npm test');
  assert.equal(parsed.prompt, 'update src/index.ts');
});

test('execute without approval does not apply changes', () => {
  const root = makeTempDir();
  try {
    const file = join(root, 'sample.ts');
    writeFileSync(file, 'const value = 1;\n');

    const result = runCli(['--execute', 'Update sample.ts'], root);

    assert.equal(result.status, 2, result.stderr || result.stdout);
    assert.equal(readFileSync(file, 'utf8'), 'const value = 1;\n');
    assert.match(result.stdout, /Workflow: dry-run/);
    assert.match(result.stdout, /approval missing/i);
    assert.match(result.stdout, /No files were changed/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('execute with approval applies real changes', () => {
  const root = makeTempDir();
  try {
    const file = join(root, 'sample.ts');
    writeFileSync(file, 'const value = 1;\n');

    const result = runCli(['--execute', '--approve', 'Update sample.ts'], root);

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const content = readFileSync(file, 'utf8');
    assert.match(content, /JackCode applied requested update/);
    assert.match(result.stdout, /Workflow: applied/);
    assert.match(result.stdout, /Applied changes:/);
    assert.match(result.stdout, /Result: applied 1 patch/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification failure rolls back applied changes', () => {
  const root = makeTempDir();
  try {
    const file = join(root, 'sample.ts');
    writeFileSync(file, 'const value = 1;\n');
    const verifier = join(root, 'verify-fail.js');
    writeFileSync(verifier, 'process.stderr.write("verification exploded\\n"); process.exit(1);\n');

    const result = runCli(['--execute', '--approve', '--verify-cmd', `${process.execPath} ${verifier}`, 'Update sample.ts'], root);

    assert.equal(result.status, 4, result.stderr || result.stdout);
    assert.equal(readFileSync(file, 'utf8'), 'const value = 1;\n');
    assert.match(result.stdout, /Workflow: rolled-back/);
    assert.match(result.stdout, /Rollback: performed after verification failure/);
    assert.match(result.stdout, /Final state: no applied file changes remain/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

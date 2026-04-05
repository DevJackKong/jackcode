import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ContextCompressor,
  RepoContextCompressor,
  compressContext,
  compressRepoContext,
  createBudgetPlan,
  estimateTokens,
  getModelBudget,
} from './context-compressor.js';

import type { ContextFragment } from '../types/context.js';
import type { FileContext, RepoMap } from './types.js';

function fragment(overrides: Partial<ContextFragment> = {}): ContextFragment {
  const now = Date.now();
  return {
    id: overrides.id ?? `fragment-${Math.random().toString(16).slice(2)}`,
    type: overrides.type ?? 'code',
    content: overrides.content ?? 'export function alpha() { return 1; }',
    source: overrides.source,
    timestamp: overrides.timestamp ?? now,
    tokenCount: overrides.tokenCount,
    metadata: {
      accessCount: overrides.metadata?.accessCount ?? 1,
      lastAccess: overrides.metadata?.lastAccess ?? now,
      priority: overrides.metadata?.priority ?? 0.5,
      tags: overrides.metadata?.tags ?? [],
    },
  };
}

function fileContext(overrides: Partial<FileContext> = {}): FileContext {
  const base = fragment({
    type: overrides.type ?? 'code',
    content: overrides.content ?? 'export interface Foo { id: string }\nexport function run(a: string) {\n  const x = 1;\n  return a + x;\n}',
    source: overrides.source ?? overrides.relativePath ?? 'src/foo.ts',
    metadata: overrides.metadata,
    timestamp: overrides.timestamp,
    tokenCount: overrides.tokenCount,
  });

  return {
    ...base,
    type: overrides.type ?? 'code',
    relativePath: overrides.relativePath ?? 'src/foo.ts',
    language: overrides.language ?? 'typescript',
    definedSymbols: overrides.definedSymbols ?? ['Foo', 'run'],
    referencedSymbols: overrides.referencedSymbols ?? ['String'],
    fileSize: overrides.fileSize ?? base.content.length,
    modifiedAt: overrides.modifiedAt ?? Date.now(),
  };
}

const repoMap: RepoMap = {
  rootPath: '.',
  fileTree: [],
  symbols: { definitions: new Map(), references: new Map() },
  generatedAt: Date.now(),
};

test('estimateTokens uses simple 4-char heuristic', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('abcdefgh'), 2);
});

test('createBudgetPlan reserves prompt/output space for model routing', () => {
  const plan = createBudgetPlan('gpt', {
    reservedOutputTokens: 4000,
    promptOverheadTokens: 1000,
  });

  assert.equal(plan.model, 'gpt');
  assert.ok(plan.inputBudget < getModelBudget('gpt').effectiveBudget);
  assert.equal(plan.reservedForOutput, 4000);
  assert.equal(plan.reservedForPrompt, 1000);
});

test('smart filtering keeps interfaces and signatures while eliding implementations', () => {
  const compressor = new ContextCompressor();
  const packed = compressor.pack([
    fileContext({
      content: [
        '// IMPORTANT: public API for callers',
        'export interface ServiceConfig {',
        '  retries: number;',
        '}',
        '',
        'export async function connect(host: string, port: number) {',
        '  const socket = await makeSocket(host, port);',
        '  const ready = await socket.ready();',
        '  return { socket, ready };',
        '}',
      ].join('\n'),
      metadata: {
        accessCount: 3,
        lastAccess: Date.now(),
        priority: 0.8,
        tags: ['critical'],
      },
    }),
  ]);

  const result = compressor.compressWithOptions(packed, { budget: 60, level: 2, query: 'connect service config' });

  assert.match(result.content, /export interface ServiceConfig/);
  assert.match(result.content, /export async function connect/);
  assert.ok(!result.content.includes('const socket = await makeSocket'));
  assert.ok(result.fragments[0]?.metadata.tags.includes('filtered') || result.fragments[0]?.metadata.tags.includes('summarized'));
});

test('query and path relevance favor core session fragments', () => {
  const compressor = new ContextCompressor();
  const packed = compressor.pack([
    fileContext({
      id: 'session',
      relativePath: 'src/core/session.ts',
      source: 'src/core/session.ts',
      content: 'export class SessionManager { resumeSession() {} prepareHandoff() {} }',
      metadata: { accessCount: 10, lastAccess: Date.now(), priority: 0.95, tags: ['critical'] },
    }),
    fileContext({
      id: 'fixture',
      relativePath: 'fixtures/sample.txt',
      source: 'fixtures/sample.txt',
      type: 'doc',
      language: null,
      definedSymbols: [],
      referencedSymbols: [],
      content: 'fixture placeholder lorem ipsum',
      metadata: { accessCount: 1, lastAccess: Date.now() - 1000 * 60 * 60 * 24, priority: 0.1, tags: [] },
    }),
  ]);

  const result = compressor.compressWithOptions(packed, { budget: 40, level: 2, query: 'session handoff resume' });

  assert.ok(result.content.includes('src/core/session.ts'));
  assert.ok(!result.content.includes('fixtures/sample.txt'));
});

test('aggressive compression truncates to fit tiny budgets', () => {
  const compressor = new ContextCompressor();
  const packed = compressor.pack([
    fragment({
      type: 'chat',
      source: 'chat.log',
      content: Array.from({ length: 200 }, (_, i) => `line ${i} with repeated context`).join('\n'),
      metadata: { accessCount: 5, lastAccess: Date.now(), priority: 0.4, tags: [] },
    }),
  ]);

  const result = compressor.compressWithOptions(packed, { budget: 8, level: 3, query: 'recent chat' });

  assert.ok(result.stats.finalTokens <= 8);
  assert.match(result.content, /truncated|elided|Summary/i);
});

test('compressSessionContext uses task stack to preserve relevant fragments', () => {
  const compressor = new RepoContextCompressor();
  const fragments = [
    fileContext({
      relativePath: 'src/model/router.ts',
      source: 'src/model/router.ts',
      content: 'export class Router { routeContext() {} }',
      metadata: { accessCount: 6, lastAccess: Date.now(), priority: 0.8, tags: [] },
    }),
    fileContext({
      relativePath: 'src/random/notes.md',
      source: 'src/random/notes.md',
      type: 'doc',
      language: null,
      definedSymbols: [],
      referencedSymbols: [],
      content: 'misc unrelated notes',
      metadata: { accessCount: 1, lastAccess: Date.now(), priority: 0.1, tags: [] },
    }),
  ];

  const result = compressor.compressSessionContext(fragments, {
    id: 'session-1',
    currentTask: {
      id: 'task-1',
      parentId: null,
      goal: 'Improve router context handoff',
      criteria: [],
      status: 'in-progress',
      createdAt: new Date(),
      updatedAt: new Date(),
      metadata: {},
    },
    taskStack: [
      {
        id: 'task-1',
        parentId: null,
        goal: 'Improve router context handoff',
        criteria: [],
        status: 'in-progress',
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {},
      },
    ],
    modelUsage: [],
  }, {
    budget: 25,
    level: 2,
    query: 'router handoff',
  });

  assert.ok(result.content.includes('src/model/router.ts'));
});

test('compressRepo integrates filtering, repo map retention, and omitted file tracking', () => {
  const compressor = new RepoContextCompressor(undefined, {
    excludePatterns: ['docs/private/**'],
    maxInlineSize: 80,
  });
  compressor.setRepoMap(repoMap);

  const files = [
    fileContext({
      relativePath: 'src/core/context.ts',
      source: 'src/core/context.ts',
      content: 'export interface ContextState { value: string }\nexport function pack() { return true; }',
      fileSize: 300,
    }),
    fileContext({
      relativePath: 'docs/private/secret.md',
      source: 'docs/private/secret.md',
      type: 'doc',
      language: null,
      definedSymbols: [],
      referencedSymbols: [],
      content: 'do not include me',
    }),
  ];

  const result = compressor.compressRepo(files, 40, { query: 'context state', level: 2 });

  assert.equal(result.repoMap.rootPath, '.');
  assert.ok(result.includedFiles.includes('src/core/context.ts'));
  assert.ok(result.omittedFiles.includes('docs/private/secret.md'));
  assert.ok(result.metrics.compressedTokens <= result.metrics.totalTokens);
});

test('compressForModel honors model-specific budgets and emits telemetry snapshot', () => {
  const compressor = new ContextCompressor();
  const packed = compressor.pack([
    fragment({
      type: 'system',
      source: 'system',
      content: 'System prompt with rules',
      metadata: { accessCount: 10, lastAccess: Date.now(), priority: 1, tags: ['critical'] },
    }),
    ...Array.from({ length: 30 }, (_, i) =>
      fragment({
        id: `chat-${i}`,
        type: 'chat',
        source: `chat-${i}`,
        content: `message ${i} `.repeat(120),
        metadata: { accessCount: 1, lastAccess: Date.now() - i * 1000, priority: 0.2, tags: [] },
      })
    ),
  ]);

  const result = compressor.compressWithOptions(packed, {
    model: 'deepseek',
    level: 3,
    reservedOutputTokens: 56000,
    promptOverheadTokens: 500,
    query: 'system rules',
  });

  const telemetry = compressor.getLastTelemetry();
  assert.ok(result.stats.finalTokens <= createBudgetPlan('deepseek', { reservedOutputTokens: 56000, promptOverheadTokens: 500 }).inputBudget);
  assert.ok(telemetry);
  assert.equal(telemetry?.model, 'deepseek');
  assert.equal(telemetry?.fragmentsIn, packed.fragments.length);
});

test('top-level helper functions remain usable', () => {
  const fragments = [fragment({ source: 'a.ts' }), fragment({ source: 'b.ts', type: 'doc' })];
  const compressed = compressContext(fragments, 20, 1);
  const repoCompressed = compressRepoContext([fileContext()], repoMap, 30);

  assert.ok(compressed.content.length > 0);
  assert.ok(repoCompressed.content.length > 0);
});

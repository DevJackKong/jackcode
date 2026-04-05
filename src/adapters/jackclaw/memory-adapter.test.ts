import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { JackClawMemoryAdapter } from './memory-adapter.js';
import type { ContextFragment } from '../../types/context.js';

function fragment(overrides: Partial<ContextFragment> = {}): ContextFragment {
  const now = Date.now();
  return {
    id: overrides.id ?? `fragment-${Math.random().toString(16).slice(2)}`,
    type: overrides.type ?? 'code',
    content: overrides.content ?? 'export const value = 1;',
    source: overrides.source ?? 'src/example.ts',
    timestamp: overrides.timestamp ?? now,
    tokenCount: overrides.tokenCount,
    metadata: {
      accessCount: overrides.metadata?.accessCount ?? 0,
      lastAccess: overrides.metadata?.lastAccess ?? now,
      priority: overrides.metadata?.priority ?? 0.5,
      tags: overrides.metadata?.tags ?? [],
    },
  };
}

function createAdapter(overrides: ConstructorParameters<typeof JackClawMemoryAdapter>[0] = {
  memoryPath: join(mkdtempSync(join(tmpdir(), 'jackclaw-memory-')), 'memory.json'),
  defaultMode: 'bidirectional',
  autoSyncInterval: 0,
  maxBatchSize: 100,
  defaultTtl: 0,
}): JackClawMemoryAdapter {
  return new JackClawMemoryAdapter(overrides);
}

test('stores, retrieves, updates, and deletes memory entries', async () => {
  const adapter = createAdapter();
  const stored = await adapter.store(fragment({ id: 'alpha', content: 'router session handoff', metadata: { accessCount: 0, lastAccess: Date.now(), priority: 0.8, tags: ['router', 'handoff'] } }), 'session-1');

  assert.equal(stored.metadata.fragmentId, 'alpha');

  const retrieved = await adapter.retrieve({ sessionId: 'session-1', query: 'router handoff', semantic: true, limit: 10 });
  assert.equal(retrieved.length, 1);
  assert.equal(retrieved[0]?.id, stored.id);

  const updated = await adapter.updateEntry(stored.id, {
    content: 'router session handoff updated',
    metadata: { tags: ['router', 'updated'], priority: 1 },
  });
  assert.ok(updated);
  assert.match(updated?.content ?? '', /updated/);
  assert.ok(updated?.metadata.tags.includes('router'));
  assert.ok(updated?.metadata.tags.includes('updated'));

  const deleted = await adapter.deleteEntry(stored.id);
  assert.equal(deleted, true);
  const afterDelete = await adapter.getEntry(stored.id);
  assert.equal(afterDelete, null);
});

test('semantic search, tag filters, time windows, and relevance ranking work together', async () => {
  const adapter = createAdapter();
  const now = Date.now();

  await adapter.store(fragment({
    id: 'router-core',
    content: 'router context handoff for active session',
    timestamp: now - 1000,
    metadata: { accessCount: 0, lastAccess: now - 1000, priority: 0.95, tags: ['router', 'session'] },
  }), 'session-2');
  await adapter.store(fragment({
    id: 'router-legacy',
    content: 'legacy router notes',
    timestamp: now - 1000 * 60 * 60 * 72,
    metadata: { accessCount: 0, lastAccess: now - 1000 * 60 * 60 * 72, priority: 0.3, tags: ['router'] },
    type: 'doc',
  }), 'session-2');
  await adapter.store(fragment({
    id: 'other',
    content: 'database migration steps',
    timestamp: now,
    metadata: { accessCount: 0, lastAccess: now, priority: 0.9, tags: ['db'] },
  }), 'session-2');

  const results = await adapter.retrieve({
    sessionId: 'session-2',
    query: 'router handoff session',
    tags: ['router'],
    since: now - 1000 * 60 * 60 * 24,
    limit: 5,
  });

  assert.equal(results.length, 1);
  assert.equal(results[0]?.metadata.fragmentId, 'router-core');
});

test('bidirectional sync resolves conflicts and supports delta sync behavior', async () => {
  const adapter = createAdapter();
  const old = Date.now() - 10_000;
  const newer = Date.now();

  await adapter.store(fragment({
    id: 'shared',
    content: 'remote newer version',
    timestamp: newer,
    metadata: { accessCount: 0, lastAccess: newer, priority: 0.9, tags: ['sync'] },
  }), 'session-sync');

  const result = await adapter.sync('session-sync', [
    fragment({
      id: 'shared',
      content: 'local older version',
      timestamp: old,
      metadata: { accessCount: 0, lastAccess: old, priority: 0.5, tags: ['sync'] },
    }),
    fragment({
      id: 'new-local',
      content: 'brand new local fragment',
      timestamp: newer,
      metadata: { accessCount: 0, lastAccess: newer, priority: 0.7, tags: ['sync'] },
    }),
  ]);

  assert.ok(result.conflicts >= 1);
  assert.ok(result.pushed >= 1);

  const delta = await adapter.retrieve({ sessionId: 'session-sync', since: result.timestamp - 5, limit: 10 });
  assert.ok(delta.some((entry) => entry.metadata.fragmentId === 'new-local'));
});

test('storage limits trigger LRU eviction', async () => {
  const adapter = createAdapter({
    memoryPath: join(mkdtempSync(join(tmpdir(), 'jackclaw-memory-')), 'memory.json'),
    defaultMode: 'bidirectional',
    autoSyncInterval: 0,
    maxBatchSize: 100,
    defaultTtl: 0,
    maxEntries: 2,
    storageLimitBytes: 1024 * 1024,
  });

  await adapter.store(fragment({ id: 'a', content: 'alpha', metadata: { accessCount: 0, lastAccess: Date.now() - 1000, priority: 0.3, tags: ['lru'] } }), 'session-lru');
  await adapter.store(fragment({ id: 'b', content: 'beta', metadata: { accessCount: 0, lastAccess: Date.now(), priority: 0.4, tags: ['lru'] } }), 'session-lru');
  await adapter.retrieve({ sessionId: 'session-lru', query: 'beta', limit: 1 });
  await adapter.store(fragment({ id: 'c', content: 'gamma', metadata: { accessCount: 0, lastAccess: Date.now(), priority: 0.9, tags: ['lru'] } }), 'session-lru');

  const stats = await adapter.getStorageStats();
  assert.equal(stats.entries, 2);

  const all = await adapter.retrieve({ sessionId: 'session-lru', limit: 10, includeDeleted: true });
  assert.equal(all.some((entry) => entry.metadata.fragmentId === 'a'), false);
});

test('compression and encryption are applied for large stored entries', async () => {
  const adapter = createAdapter({
    memoryPath: join(mkdtempSync(join(tmpdir(), 'jackclaw-memory-')), 'memory.json'),
    defaultMode: 'bidirectional',
    autoSyncInterval: 0,
    maxBatchSize: 100,
    defaultTtl: 0,
    enableCompression: true,
    compressionThresholdBytes: 64,
    encryptionKey: 'super-secret-test-key',
  });

  const largeContent = Array.from({ length: 200 }, (_, i) => `router handoff context line ${i}`).join('\n');
  const stored = await adapter.store(fragment({
    id: 'secure',
    content: largeContent,
    metadata: { accessCount: 0, lastAccess: Date.now(), priority: 0.8, tags: ['secure'] },
  }), 'session-secure');

  assert.equal(stored.content.length > 0, true);
  assert.equal(stored.metadata.compressed, true);
  assert.equal(stored.metadata.encrypted, true);

  const reloaded = await adapter.getEntry(stored.id);
  assert.equal(reloaded?.content, largeContent);
});

test('pull returns session-context-ready fragments', async () => {
  const adapter = createAdapter();
  await adapter.store(fragment({
    id: 'session-context',
    type: 'doc',
    content: 'Decision: prefer reusable adapters',
    source: 'task:123',
    metadata: { accessCount: 0, lastAccess: Date.now(), priority: 0.7, tags: ['learning', 'session'] },
  }), 'session-context');

  const pulled = await adapter.pull({ sessionId: 'session-context', limit: 5 });
  assert.equal(pulled.length, 1);
  assert.equal(pulled[0]?.id, 'session-context');
  assert.equal(pulled[0]?.type, 'doc');
  assert.ok(pulled[0]?.metadata.tags.includes('learning'));
});

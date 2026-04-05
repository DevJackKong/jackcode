/**
 * JackClaw Memory Adapter
 * Thread 14: Bidirectional memory sync between JackCode and JackClaw
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';

import { ContextCompressor } from '../../repo/context-compressor.js';
import { telemetry, telemetryMetrics } from '../../core/telemetry.js';
import type { ContextFragment, FragmentType } from '../../types/context.js';

// ============================================================================
// Types
// ============================================================================

/** Types of memory entries that can be synced */
export type MemoryEntryType =
  | 'decision'
  | 'learning'
  | 'context'
  | 'checkpoint'
  | 'error';

/** Sync direction modes */
export type SyncMode = 'pull' | 'push' | 'bidirectional';

/** Memory entry metadata */
export interface MemoryMetadata {
  tags: string[];
  source?: string;
  priority: number;
  fragmentId?: string;
  updatedAt?: number;
  deletedAt?: number | null;
  lastAccessedAt?: number;
  accessCount?: number;
  checksum?: string;
  compressed?: boolean;
  encrypted?: boolean;
  compressedFromBytes?: number;
  sessionTaskId?: string;
  sessionContext?: {
    rootGoal?: string;
    currentTaskGoal?: string;
  };
  sync?: {
    origin: 'jackcode' | 'jackclaw';
    version: number;
    lastSyncedAt?: number;
    deltaToken?: string;
  };
  [key: string]: unknown;
}

/** Memory entry in JackClaw format */
export interface MemoryEntry {
  id: string;
  sessionId: string;
  type: MemoryEntryType;
  content: string;
  metadata: MemoryMetadata;
  timestamp: number;
  expiresAt: number | null;
}

/** Query for fetching memory entries */
export interface MemoryQuery {
  sessionId?: string;
  types?: MemoryEntryType[];
  tags?: string[];
  since?: number;
  until?: number;
  limit?: number;
  query?: string;
  semantic?: boolean;
  includeDeleted?: boolean;
  minPriority?: number;
}

/** Result of a sync operation */
export interface SyncResult {
  mode: SyncMode;
  pulled: number;
  pushed: number;
  conflicts: number;
  errors: SyncError[];
  timestamp: number;
}

/** Sync error details */
export interface SyncError {
  entryId?: string;
  message: string;
  type: 'read' | 'write' | 'transform' | 'conflict';
}

/** Adapter configuration */
export interface MemoryAdapterConfig {
  memoryPath: string;
  defaultMode: SyncMode;
  autoSyncInterval: number;
  maxBatchSize: number;
  defaultTtl: number;
  maxEntries?: number;
  storageLimitBytes?: number;
  evictionPolicy?: 'lru';
  enableCompression?: boolean;
  compressionThresholdBytes?: number;
  encryptionKey?: string;
  compressorBudget?: number;
}

interface StoredMemoryEntry {
  id: string;
  sessionId: string;
  type: MemoryEntryType;
  payload: string;
  metadata: MemoryMetadata;
  timestamp: number;
  expiresAt: number | null;
  deleted: boolean;
  lastAccessedAt: number;
  accessCount: number;
  sizeBytes: number;
}

interface QueryCandidate {
  entry: MemoryEntry;
  score: number;
  breakdown: {
    semantic: number;
    tags: number;
    recency: number;
    priority: number;
  };
}

interface PersistedMemoryStore {
  version: 1;
  updatedAt: number;
  entries: StoredMemoryEntry[];
}

// ============================================================================
// Memory Adapter Implementation
// ============================================================================

export class JackClawMemoryAdapter {
  private config: Required<Pick<MemoryAdapterConfig,
    'defaultMode' |
    'autoSyncInterval' |
    'maxBatchSize' |
    'defaultTtl' |
    'maxEntries' |
    'storageLimitBytes' |
    'evictionPolicy' |
    'enableCompression' |
    'compressionThresholdBytes' |
    'compressorBudget'
  >> & Pick<MemoryAdapterConfig, 'memoryPath'> & { encryptionKey?: string };

  private lastSyncTime = 0;
  private entryStore = new Map<string, StoredMemoryEntry>();
  private compressor = new ContextCompressor();
  private storeLoaded = false;

  constructor(config: MemoryAdapterConfig) {
    const maxBatchSize = Number.isFinite(config.maxBatchSize) && config.maxBatchSize > 0
      ? Math.floor(config.maxBatchSize)
      : 100;

    this.config = {
      memoryPath: config.memoryPath,
      defaultMode: config.defaultMode ?? 'bidirectional',
      autoSyncInterval: config.autoSyncInterval ?? 0,
      maxBatchSize,
      defaultTtl: config.defaultTtl ?? 0,
      maxEntries: config.maxEntries ?? 1000,
      storageLimitBytes: config.storageLimitBytes ?? 5 * 1024 * 1024,
      evictionPolicy: config.evictionPolicy ?? 'lru',
      enableCompression: config.enableCompression ?? true,
      compressionThresholdBytes: config.compressionThresholdBytes ?? 1024,
      encryptionKey: config.encryptionKey,
      compressorBudget: config.compressorBudget ?? 512,
    };
  }

  /**
   * Pull memory entries from JackClaw into JackCode context fragments
   */
  async pull(query: MemoryQuery): Promise<ContextFragment[]> {
    return telemetry.startActiveSpan('jackclaw.memory.pull', async (span) => {
      const entries = await this.queryMemory(query);
      span.setAttributes({
        'memory.results': entries.length,
        'memory.session_id': query.sessionId,
      });
      telemetryMetrics.incrementCounter('jackcode.memory.pull.calls', 1, {
        mode: 'pull',
      });
      return entries.map((entry) => this.entryToFragment(entry));
    }, {
      attributes: {
        component: 'jackclaw-memory-adapter',
      },
    });
  }

  /**
   * Push JackCode context fragments to JackClaw memory
   */
  async push(fragments: ContextFragment[], sessionId: string): Promise<SyncResult> {
    return telemetry.startActiveSpan('jackclaw.memory.push', async (span) => {
      await this.ensureLoaded();
      const result: SyncResult = {
        mode: 'push',
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        errors: [],
        timestamp: Date.now(),
      };

      for (const fragment of fragments.slice(0, this.config.maxBatchSize)) {
        try {
          const existing = this.findEntryByFragmentId(sessionId, fragment.id);
          if (existing && (existing.metadata.updatedAt ?? existing.timestamp) > fragment.timestamp) {
            result.conflicts += 1;
            result.errors.push({
              entryId: existing.id,
              message: `Remote entry is newer for fragment ${fragment.id}`,
              type: 'conflict',
            });
            continue;
          }

          const entry = this.fragmentToEntry(fragment, sessionId, existing?.id);
          await this.writeEntry(entry);
          result.pushed += 1;
        } catch (err) {
          result.errors.push({
            entryId: fragment.id,
            message: err instanceof Error ? err.message : String(err),
            type: 'write',
          });
        }
      }

      this.lastSyncTime = result.timestamp;
      span.setAttributes({
        'memory.pushed': result.pushed,
        'memory.conflicts': result.conflicts,
      });
      telemetryMetrics.incrementCounter('jackcode.memory.push.calls', 1, {
        mode: 'push',
      });
      return result;
    }, {
      attributes: {
        component: 'jackclaw-memory-adapter',
      },
    });
  }

  /**
   * Perform bidirectional sync with conflict resolution and delta sync.
   */
  async sync(sessionId: string, localFragments: ContextFragment[]): Promise<SyncResult> {
    return telemetry.startActiveSpan('jackclaw.memory.sync', async (span) => {
      await this.ensureLoaded();
      const result: SyncResult = {
        mode: 'bidirectional',
        pulled: 0,
        pushed: 0,
        conflicts: 0,
        errors: [],
        timestamp: Date.now(),
      };

      try {
        const remoteEntries = await this.queryMemory({
          sessionId,
          since: this.lastSyncTime || undefined,
          limit: this.config.maxBatchSize,
          includeDeleted: false,
          semantic: false,
        });

        const localByFragmentId = new Map(localFragments.map((fragment) => [fragment.id, fragment]));

        for (const remoteEntry of remoteEntries) {
          const fragmentId = remoteEntry.metadata.fragmentId ?? remoteEntry.id;
          const local = localByFragmentId.get(fragmentId);
          if (!local) {
            result.pulled += 1;
            continue;
          }

          const remoteUpdatedAt = remoteEntry.metadata.updatedAt ?? remoteEntry.timestamp;
          if (remoteUpdatedAt > local.timestamp) {
            result.conflicts += 1;
            result.pulled += 1;
          }
        }
      } catch (err) {
        result.errors.push({
          message: err instanceof Error ? err.message : String(err),
          type: 'read',
        });
      }

      for (const fragment of localFragments.slice(0, this.config.maxBatchSize)) {
        try {
          const existing = this.findEntryByFragmentId(sessionId, fragment.id);
          if (existing) {
            const remoteUpdatedAt = existing.metadata.updatedAt ?? existing.timestamp;
            if (remoteUpdatedAt > fragment.timestamp) {
              result.conflicts += 1;
              continue;
            }
          }

          const entry = this.fragmentToEntry(fragment, sessionId, existing?.id);
          await this.writeEntry(entry);
          result.pushed += 1;
        } catch (err) {
          result.errors.push({
            entryId: fragment.id,
            message: err instanceof Error ? err.message : String(err),
            type: 'write',
          });
        }
      }

      this.lastSyncTime = result.timestamp;
      span.setAttributes({
        'memory.pulled': result.pulled,
        'memory.pushed': result.pushed,
        'memory.conflicts': result.conflicts,
      });
      telemetryMetrics.incrementCounter('jackcode.memory.sync.calls', 1, {
        mode: 'bidirectional',
      });
      return result;
    }, {
      attributes: {
        component: 'jackclaw-memory-adapter',
      },
    });
  }

  /** Store a single context fragment as durable memory. */
  async store(fragment: ContextFragment, sessionId: string): Promise<MemoryEntry> {
    await this.ensureLoaded();
    const existing = this.findEntryByFragmentId(sessionId, fragment.id);
    const entry = this.fragmentToEntry(fragment, sessionId, existing?.id);
    await this.writeEntry(entry);
    const stored = await this.getEntry(entry.id);
    if (!stored) {
      throw new Error(`Failed to read back stored memory entry ${entry.id}`);
    }
    return stored;
  }

  /** Retrieve memory entries with semantic ranking, filters, and time windows. */
  async retrieve(query: MemoryQuery): Promise<MemoryEntry[]> {
    return this.queryMemory(query);
  }

  /** Update an existing memory entry. */
  async updateEntry(
    entryId: string,
    patch: Partial<Omit<MemoryEntry, 'id' | 'sessionId'>> & { metadata?: Partial<MemoryMetadata> }
  ): Promise<MemoryEntry | null> {
    await this.ensureLoaded();
    const current = this.entryStore.get(entryId);
    if (!current || current.deleted) {
      return null;
    }

    const decoded = this.decodeStoredEntry(current);
    const next: MemoryEntry = {
      ...decoded,
      type: patch.type ?? decoded.type,
      content: patch.content ?? decoded.content,
      timestamp: patch.timestamp ?? decoded.timestamp,
      expiresAt: patch.expiresAt === undefined ? decoded.expiresAt : patch.expiresAt,
      metadata: {
        ...decoded.metadata,
        ...(patch.metadata ?? {}),
        tags: Array.from(new Set([
          ...(decoded.metadata.tags ?? []),
          ...((patch.metadata?.tags ?? []).filter(Boolean)),
        ])),
        updatedAt: Date.now(),
        deletedAt: null,
      },
    };

    await this.writeEntry(next);
    return this.getEntry(entryId);
  }

  /** Soft-delete an entry and clean up expired/tombstoned data. */
  async deleteEntry(entryId: string): Promise<boolean> {
    await this.ensureLoaded();
    const current = this.entryStore.get(entryId);
    if (!current) {
      return false;
    }

    const now = Date.now();
    current.deleted = true;
    current.metadata.deletedAt = now;
    current.metadata.updatedAt = now;
    current.payload = '';
    current.sizeBytes = JSON.stringify(current).length;
    this.entryStore.set(entryId, current);
    await this.cleanupDeletedEntries();
    await this.persistStore();
    return true;
  }

  /** Fetch one entry by id. */
  async getEntry(entryId: string): Promise<MemoryEntry | null> {
    await this.ensureLoaded();
    const current = this.entryStore.get(entryId);
    if (!current || current.deleted) {
      return null;
    }
    this.touchStoredEntry(current);
    return this.decodeStoredEntry(current);
  }

  /** Return storage stats useful for testing and telemetry. */
  async getStorageStats(): Promise<{ entries: number; bytes: number; deleted: number }> {
    await this.ensureLoaded();
    const values = Array.from(this.entryStore.values());
    return {
      entries: values.filter((entry) => !entry.deleted).length,
      bytes: values.reduce((sum, entry) => sum + entry.sizeBytes, 0),
      deleted: values.filter((entry) => entry.deleted).length,
    };
  }

  /**
   * Query memory entries from JackClaw storage
   */
  private async queryMemory(query: MemoryQuery): Promise<MemoryEntry[]> {
    await this.ensureLoaded();
    await this.cleanupExpiredEntries();

    const now = Date.now();
    const limit = query.limit && query.limit > 0
      ? Math.min(query.limit, this.config.maxBatchSize)
      : this.config.maxBatchSize;
    const requestedTags = Array.from(new Set(query.tags ?? []));
    const queryText = (query.query ?? '').trim();

    const candidates: QueryCandidate[] = [];
    for (const stored of this.entryStore.values()) {
      if (stored.deleted && !query.includeDeleted) continue;
      if (!query.includeDeleted && stored.expiresAt !== null && stored.expiresAt <= now) continue;
      if (query.sessionId && stored.sessionId !== query.sessionId) continue;

      const entry = this.decodeStoredEntry(stored);
      if (query.types?.length && !query.types.includes(entry.type)) continue;
      if (requestedTags.length > 0 && !requestedTags.every((tag) => entry.metadata.tags.includes(tag))) continue;
      if (typeof query.since === 'number' && entry.timestamp < query.since) continue;
      if (typeof query.until === 'number' && entry.timestamp > query.until) continue;
      if (typeof query.minPriority === 'number' && entry.metadata.priority < query.minPriority) continue;

      const breakdown = this.scoreEntry(entry, queryText, requestedTags);
      candidates.push({
        entry,
        score: breakdown.semantic * 0.45 + breakdown.tags * 0.2 + breakdown.recency * 0.15 + breakdown.priority * 0.2,
        breakdown,
      });
    }

    const sorted = candidates
      .sort((a, b) => {
        const scoreDelta = b.score - a.score;
        if (scoreDelta !== 0) return scoreDelta;
        const updatedDelta = (b.entry.metadata.updatedAt ?? b.entry.timestamp) - (a.entry.metadata.updatedAt ?? a.entry.timestamp);
        if (updatedDelta !== 0) return updatedDelta;
        return b.entry.timestamp - a.entry.timestamp;
      })
      .slice(0, limit)
      .map((candidate) => candidate.entry);

    for (const entry of sorted) {
      const stored = this.entryStore.get(entry.id);
      if (stored) {
        this.touchStoredEntry(stored);
      }
    }
    await this.persistStore();
    return sorted.map((entry) => ({
      ...entry,
      metadata: {
        ...entry.metadata,
        tags: [...entry.metadata.tags],
      },
    }));
  }

  /**
   * Write entry to JackClaw memory storage
   */
  private async writeEntry(entry: MemoryEntry): Promise<void> {
    await this.ensureLoaded();
    const normalized = this.normalizeEntry(entry);
    const stored = this.encodeEntry(normalized);
    this.entryStore.set(stored.id, stored);
    await this.enforceStorageLimits();
    await this.persistStore();
  }

  /**
   * Convert MemoryEntry to JackCode ContextFragment
   */
  private entryToFragment(entry: MemoryEntry): ContextFragment {
    const typeMap: Record<MemoryEntryType, FragmentType> = {
      decision: 'system',
      learning: 'doc',
      context: 'code',
      checkpoint: 'system',
      error: 'error',
    };

    return {
      id: entry.metadata.fragmentId || entry.id,
      type: typeMap[entry.type],
      content: entry.content,
      source: entry.metadata.source,
      timestamp: entry.metadata.updatedAt ?? entry.timestamp,
      metadata: {
        accessCount: entry.metadata.accessCount ?? 0,
        lastAccess: entry.metadata.lastAccessedAt ?? entry.timestamp,
        priority: this.normalizePriority(entry.metadata.priority),
        tags: [...entry.metadata.tags],
      },
    };
  }

  /**
   * Convert JackCode ContextFragment to MemoryEntry
   */
  private fragmentToEntry(fragment: ContextFragment, sessionId: string, existingId?: string): MemoryEntry {
    const now = Date.now();
    return {
      id: existingId ?? `mem_${sessionId}_${fragment.id}`,
      sessionId,
      type: this.inferEntryType(fragment.type),
      content: fragment.content,
      metadata: {
        tags: Array.from(new Set([...fragment.metadata.tags])),
        source: fragment.source,
        priority: this.normalizePriority(fragment.metadata.priority),
        fragmentId: fragment.id,
        updatedAt: now,
        deletedAt: null,
        lastAccessedAt: fragment.metadata.lastAccess,
        accessCount: fragment.metadata.accessCount,
        sessionContext: {
          currentTaskGoal: typeof fragment.source === 'string' ? fragment.source : undefined,
        },
        sync: {
          origin: 'jackcode',
          version: now,
          lastSyncedAt: now,
          deltaToken: `${sessionId}:${fragment.id}:${now}`,
        },
      },
      timestamp: fragment.timestamp,
      expiresAt: this.config.defaultTtl > 0 ? now + this.config.defaultTtl : null,
    };
  }

  /**
   * Infer memory entry type from fragment type
   */
  private inferEntryType(fragmentType: FragmentType): MemoryEntryType {
    const typeMap: Record<FragmentType, MemoryEntryType> = {
      code: 'context',
      doc: 'learning',
      chat: 'context',
      error: 'error',
      system: 'decision',
      'file-tree': 'context',
      symbol: 'context',
    };
    return typeMap[fragmentType];
  }

  /**
   * Normalize priority values to 0..1
   */
  private normalizePriority(priority: number): number {
    if (!Number.isFinite(priority)) {
      return 0;
    }
    return Math.min(1, Math.max(0, priority));
  }

  private normalizeEntry(entry: MemoryEntry): MemoryEntry {
    const tags = Array.isArray(entry.metadata.tags) ? Array.from(new Set(entry.metadata.tags)) : [];
    const updatedAt = entry.metadata.updatedAt ?? Date.now();

    return {
      ...entry,
      metadata: {
        ...entry.metadata,
        tags,
        priority: this.normalizePriority(entry.metadata.priority),
        updatedAt,
        deletedAt: entry.metadata.deletedAt ?? null,
        lastAccessedAt: entry.metadata.lastAccessedAt ?? entry.timestamp,
        accessCount: entry.metadata.accessCount ?? 0,
        checksum: this.hash(entry.content),
      },
    };
  }

  private async ensureLoaded(): Promise<void> {
    if (this.storeLoaded) {
      return;
    }

    const storeFile = this.getStoreFilePath();
    if (existsSync(storeFile)) {
      const raw = JSON.parse(readFileSync(storeFile, 'utf-8')) as PersistedMemoryStore;
      this.entryStore = new Map((raw.entries ?? []).map((entry) => [entry.id, entry]));
    }
    this.storeLoaded = true;
  }

  private async persistStore(): Promise<void> {
    const storeFile = this.getStoreFilePath();
    mkdirSync(dirname(storeFile), { recursive: true });
    const payload: PersistedMemoryStore = {
      version: 1,
      updatedAt: Date.now(),
      entries: Array.from(this.entryStore.values()),
    };
    writeFileSync(storeFile, JSON.stringify(payload, null, 2), 'utf-8');
  }

  private getStoreFilePath(): string {
    if (extname(this.config.memoryPath)) {
      return this.config.memoryPath;
    }
    return join(this.config.memoryPath, 'memory-store.json');
  }

  private encodeEntry(entry: MemoryEntry): StoredMemoryEntry {
    const prepared = this.prepareContentForStorage(entry);
    const payload = JSON.stringify({
      content: prepared.content,
      metadata: {
        compressed: prepared.compressed,
        encrypted: prepared.encrypted,
      },
    });

    const accessCount = entry.metadata.accessCount ?? 0;
    const lastAccessedAt = entry.metadata.lastAccessedAt ?? entry.timestamp;

    const stored: StoredMemoryEntry = {
      id: entry.id,
      sessionId: entry.sessionId,
      type: entry.type,
      payload,
      metadata: {
        ...entry.metadata,
        compressed: prepared.compressed,
        encrypted: prepared.encrypted,
        compressedFromBytes: prepared.compressedFromBytes,
      },
      timestamp: entry.timestamp,
      expiresAt: entry.expiresAt,
      deleted: entry.metadata.deletedAt != null,
      lastAccessedAt,
      accessCount,
      sizeBytes: 0,
    };
    stored.sizeBytes = JSON.stringify(stored).length;
    return stored;
  }

  private decodeStoredEntry(stored: StoredMemoryEntry): MemoryEntry {
    const parsed = JSON.parse(stored.payload || '{"content":"","metadata":{}}') as {
      content?: string;
      metadata?: { compressed?: boolean; encrypted?: boolean };
    };

    const content = this.restoreContentFromStorage(
      parsed.content ?? '',
      Boolean(parsed.metadata?.compressed ?? stored.metadata.compressed),
      Boolean(parsed.metadata?.encrypted ?? stored.metadata.encrypted)
    );

    return {
      id: stored.id,
      sessionId: stored.sessionId,
      type: stored.type,
      content,
      metadata: {
        ...stored.metadata,
        tags: [...stored.metadata.tags],
        accessCount: stored.accessCount,
        lastAccessedAt: stored.lastAccessedAt,
      },
      timestamp: stored.timestamp,
      expiresAt: stored.expiresAt,
    };
  }

  private prepareContentForStorage(entry: MemoryEntry): {
    content: string;
    compressed: boolean;
    encrypted: boolean;
    compressedFromBytes?: number;
  } {
    let content = entry.content;
    let compressed = false;
    let compressedFromBytes: number | undefined;

    if (this.config.enableCompression && Buffer.byteLength(content, 'utf8') >= this.config.compressionThresholdBytes) {
      const fragment = this.entryToFragment(entry);
      const packed = this.compressor.pack([fragment]);
      this.compressor.compress(packed, this.config.compressorBudget);
      const gzipped = gzipSync(Buffer.from(content, 'utf8')).toString('base64');
      compressedFromBytes = Buffer.byteLength(content, 'utf8');
      content = gzipped;
      compressed = true;
    }

    let encrypted = false;
    if (this.config.encryptionKey) {
      content = this.encrypt(content, this.config.encryptionKey);
      encrypted = true;
    }

    return { content, compressed, encrypted, compressedFromBytes };
  }

  private restoreContentFromStorage(content: string, compressed: boolean, encrypted: boolean): string {
    let decoded = content;
    if (encrypted && this.config.encryptionKey) {
      decoded = this.decrypt(decoded, this.config.encryptionKey);
    }
    if (compressed) {
      decoded = gunzipSync(Buffer.from(decoded, 'base64')).toString('utf8');
    }
    return decoded;
  }

  private encrypt(content: string, key: string): string {
    const iv = randomBytes(12);
    const secret = createHash('sha256').update(key).digest();
    const cipher = createCipheriv('aes-256-gcm', secret, iv);
    const encrypted = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, encrypted]).toString('base64');
  }

  private decrypt(content: string, key: string): string {
    const buffer = Buffer.from(content, 'base64');
    const iv = buffer.subarray(0, 12);
    const tag = buffer.subarray(12, 28);
    const encrypted = buffer.subarray(28);
    const secret = createHash('sha256').update(key).digest();
    const decipher = createDecipheriv('aes-256-gcm', secret, iv);
    decipher.setAuthTag(tag);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return decrypted.toString('utf8');
  }

  private scoreEntry(entry: MemoryEntry, queryText: string, requestedTags: string[]): QueryCandidate['breakdown'] {
    const semantic = this.calculateSemanticScore(entry, queryText);
    const tags = requestedTags.length === 0
      ? Math.min(1, entry.metadata.tags.length * 0.12 + 0.2)
      : requestedTags.filter((tag) => entry.metadata.tags.includes(tag)).length / requestedTags.length;
    const age = Date.now() - (entry.metadata.updatedAt ?? entry.timestamp);
    const ageHours = Math.max(0, age / (1000 * 60 * 60));
    const recency = Math.exp(-ageHours / 48);
    const priority = this.normalizePriority(entry.metadata.priority);

    return { semantic, tags, recency, priority };
  }

  private calculateSemanticScore(entry: MemoryEntry, queryText: string): number {
    if (!queryText.trim()) {
      return 0.5;
    }

    const queryTokens = this.tokenize(queryText);
    if (queryTokens.length === 0) {
      return 0.5;
    }

    const haystack = [
      entry.content,
      entry.metadata.source ?? '',
      entry.type,
      entry.metadata.tags.join(' '),
      entry.metadata.fragmentId ?? '',
      typeof entry.metadata.sessionContext?.rootGoal === 'string' ? entry.metadata.sessionContext.rootGoal : '',
      typeof entry.metadata.sessionContext?.currentTaskGoal === 'string' ? entry.metadata.sessionContext.currentTaskGoal : '',
    ].join(' ').toLowerCase();

    const haystackTokens = new Set(this.tokenize(haystack));
    let exactMatches = 0;
    let partialMatches = 0;

    for (const token of queryTokens) {
      if (haystackTokens.has(token)) {
        exactMatches += 1;
        continue;
      }
      for (const candidate of haystackTokens) {
        if (candidate.includes(token) || token.includes(candidate)) {
          partialMatches += 1;
          break;
        }
      }
    }

    return this.clamp01((exactMatches + partialMatches * 0.5) / queryTokens.length);
  }

  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_/$.-]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2);
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private hash(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private findEntryByFragmentId(sessionId: string, fragmentId: string): MemoryEntry | null {
    for (const stored of this.entryStore.values()) {
      if (stored.deleted) continue;
      if (stored.sessionId !== sessionId) continue;
      if (stored.metadata.fragmentId === fragmentId) {
        return this.decodeStoredEntry(stored);
      }
    }
    return null;
  }

  private touchStoredEntry(stored: StoredMemoryEntry): void {
    stored.lastAccessedAt = Date.now();
    stored.accessCount += 1;
    stored.metadata.lastAccessedAt = stored.lastAccessedAt;
    stored.metadata.accessCount = stored.accessCount;
    stored.sizeBytes = JSON.stringify(stored).length;
    this.entryStore.set(stored.id, stored);
  }

  private async cleanupExpiredEntries(): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [id, stored] of this.entryStore.entries()) {
      if (stored.expiresAt !== null && stored.expiresAt <= now) {
        this.entryStore.delete(id);
        changed = true;
      }
    }
    if (changed) {
      await this.persistStore();
    }
  }

  private async cleanupDeletedEntries(): Promise<void> {
    let changed = false;
    for (const [id, stored] of this.entryStore.entries()) {
      if (stored.deleted && stored.payload === '') {
        this.entryStore.delete(id);
        changed = true;
      }
    }
    if (changed) {
      await this.persistStore();
    }
  }

  private async enforceStorageLimits(): Promise<void> {
    if (this.entryStore.size <= this.config.maxEntries && this.calculateStorageBytes() <= this.config.storageLimitBytes) {
      return;
    }

    const liveEntries = Array.from(this.entryStore.values())
      .filter((entry) => !entry.deleted)
      .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.timestamp - b.timestamp);

    while (
      (this.entryStore.size > this.config.maxEntries || this.calculateStorageBytes() > this.config.storageLimitBytes)
      && liveEntries.length > 0
    ) {
      const evicted = liveEntries.shift();
      if (!evicted) break;
      this.entryStore.delete(evicted.id);
      telemetryMetrics.incrementCounter('jackcode.memory.evictions', 1, {
        policy: this.config.evictionPolicy,
      });
    }
  }

  private calculateStorageBytes(): number {
    return Array.from(this.entryStore.values()).reduce((sum, entry) => sum + entry.sizeBytes, 0);
  }

  /**
   * Get last sync timestamp
   */
  getLastSyncTime(): number {
    return this.lastSyncTime;
  }

  /**
   * Get adapter configuration
   */
  getConfig(): MemoryAdapterConfig {
    return { ...this.config };
  }
}

// ============================================================================
// Factory & Helpers
// ============================================================================

/**
 * Create a memory adapter with default configuration
 */
export function createMemoryAdapter(memoryPath: string): JackClawMemoryAdapter {
  return new JackClawMemoryAdapter({
    memoryPath,
    defaultMode: 'bidirectional',
    autoSyncInterval: 0,
    maxBatchSize: 100,
    defaultTtl: 0,
  });
}

/**
 * Default export
 */
export default JackClawMemoryAdapter;

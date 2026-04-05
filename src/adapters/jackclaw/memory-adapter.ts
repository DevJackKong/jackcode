/**
 * JackClaw Memory Adapter
 * Thread 14: Bidirectional memory sync between JackCode and JackClaw
 */

import { ContextFragment, FragmentType } from '../../types/context.js';

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

/** Memory entry metadata */
export interface MemoryMetadata {
  tags: string[];
  source?: string;
  priority: number;
  fragmentId?: string;
}

/** Query for fetching memory entries */
export interface MemoryQuery {
  sessionId?: string;
  types?: MemoryEntryType[];
  tags?: string[];
  since?: number;
  limit?: number;
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
}

// ============================================================================
// Memory Adapter Implementation
// ============================================================================

export class JackClawMemoryAdapter {
  private config: MemoryAdapterConfig;
  private lastSyncTime = 0;
  private entryStore = new Map<string, MemoryEntry>();

  constructor(config: MemoryAdapterConfig) {
    const maxBatchSize = Number.isFinite(config.maxBatchSize) && config.maxBatchSize > 0
      ? Math.floor(config.maxBatchSize)
      : 100;

    this.config = {
      defaultMode: 'bidirectional',
      autoSyncInterval: 0,
      maxBatchSize,
      defaultTtl: 0,
      ...config,
      maxBatchSize,
    };
  }

  /**
   * Pull memory entries from JackClaw into JackCode context fragments
   */
  async pull(query: MemoryQuery): Promise<ContextFragment[]> {
    const entries = await this.queryMemory(query);
    return entries.map((entry) => this.entryToFragment(entry));
  }

  /**
   * Push JackCode context fragments to JackClaw memory
   */
  async push(fragments: ContextFragment[], sessionId: string): Promise<SyncResult> {
    const result: SyncResult = {
      mode: 'push',
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      errors: [],
      timestamp: Date.now(),
    };

    for (const fragment of fragments.slice(0, this.config.maxBatchSize)) {
      const entry = this.fragmentToEntry(fragment, sessionId);
      try {
        await this.writeEntry(entry);
        result.pushed += 1;
      } catch (err) {
        result.errors.push({
          entryId: entry.id,
          message: err instanceof Error ? err.message : String(err),
          type: 'write',
        });
      }
    }

    this.lastSyncTime = result.timestamp;
    return result;
  }

  /**
   * Perform bidirectional sync with conflict resolution
   */
  async sync(sessionId: string, localFragments: ContextFragment[]): Promise<SyncResult> {
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
        limit: this.config.maxBatchSize,
      });
      result.pulled = remoteEntries.length;
    } catch (err) {
      result.errors.push({
        message: err instanceof Error ? err.message : String(err),
        type: 'read',
      });
    }

    const seenFragmentIds = new Set<string>();
    for (const fragment of localFragments.slice(0, this.config.maxBatchSize)) {
      const fragmentId = fragment.id;
      if (seenFragmentIds.has(fragmentId)) {
        result.conflicts += 1;
        result.errors.push({
          entryId: fragmentId,
          message: `Duplicate fragment encountered during sync: ${fragmentId}`,
          type: 'conflict',
        });
        continue;
      }
      seenFragmentIds.add(fragmentId);

      const entry = this.fragmentToEntry(fragment, sessionId);
      try {
        await this.writeEntry(entry);
        result.pushed += 1;
      } catch (err) {
        result.errors.push({
          entryId: entry.id,
          message: err instanceof Error ? err.message : String(err),
          type: 'write',
        });
      }
    }

    this.lastSyncTime = result.timestamp;
    return result;
  }

  /**
   * Query memory entries from JackClaw storage
   */
  private async queryMemory(query: MemoryQuery): Promise<MemoryEntry[]> {
    const now = Date.now();
    const limit = query.limit && query.limit > 0
      ? Math.min(query.limit, this.config.maxBatchSize)
      : this.config.maxBatchSize;

    const entries = Array.from(this.entryStore.values())
      .filter((entry) => entry.expiresAt === null || entry.expiresAt > now)
      .filter((entry) => (query.sessionId ? entry.sessionId === query.sessionId : true))
      .filter((entry) => (query.types?.length ? query.types.includes(entry.type) : true))
      .filter((entry) => (query.tags?.length
        ? query.tags.every((tag) => entry.metadata.tags.includes(tag))
        : true))
      .filter((entry) => (typeof query.since === 'number' ? entry.timestamp >= query.since : true))
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);

    return entries.map((entry) => ({
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
    const tags = Array.isArray(entry.metadata.tags) ? [...entry.metadata.tags] : [];
    const normalizedEntry: MemoryEntry = {
      ...entry,
      metadata: {
        ...entry.metadata,
        tags,
        priority: this.normalizePriority(entry.metadata.priority),
      },
    };

    this.entryStore.set(normalizedEntry.id, normalizedEntry);
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
      timestamp: entry.timestamp,
      metadata: {
        accessCount: 0,
        lastAccess: entry.timestamp,
        priority: this.normalizePriority(entry.metadata.priority),
        tags: [...entry.metadata.tags],
      },
    };
  }

  /**
   * Convert JackCode ContextFragment to MemoryEntry
   */
  private fragmentToEntry(fragment: ContextFragment, sessionId: string): MemoryEntry {
    const now = Date.now();
    return {
      id: `mem_${sessionId}_${fragment.id}_${now}`,
      sessionId,
      type: this.inferEntryType(fragment.type),
      content: fragment.content,
      metadata: {
        tags: [...fragment.metadata.tags],
        source: fragment.source,
        priority: this.normalizePriority(fragment.metadata.priority),
        fragmentId: fragment.id,
      },
      timestamp: now,
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

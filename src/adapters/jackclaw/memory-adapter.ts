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
  | 'decision'   // Key decisions made
  | 'learning'   // Insights and learnings
  | 'context'    // Important context
  | 'checkpoint' // Session checkpoint refs
  | 'error';     // Errors and resolutions

/** Sync direction modes */
export type SyncMode = 'pull' | 'push' | 'bidirectional';

/** Memory entry in JackClaw format */
export interface MemoryEntry {
  /** Unique identifier */
  id: string;
  /** Associated session ID */
  sessionId: string;
  /** Entry type category */
  type: MemoryEntryType;
  /** Content payload */
  content: string;
  /** Entry metadata */
  metadata: MemoryMetadata;
  /** Creation timestamp */
  timestamp: number;
  /** Expiration timestamp (null = never) */
  expiresAt: number | null;
}

/** Memory entry metadata */
export interface MemoryMetadata {
  /** Semantic tags for categorization */
  tags: string[];
  /** Source file/path reference */
  source?: string;
  /** Importance score (0-1) */
  priority: number;
  /** Original JackCode fragment ID (if applicable) */
  fragmentId?: string;
}

/** Query for fetching memory entries */
export interface MemoryQuery {
  /** Filter by session ID */
  sessionId?: string;
  /** Filter by entry types */
  types?: MemoryEntryType[];
  /** Filter by tags */
  tags?: string[];
  /** Only entries since this timestamp */
  since?: number;
  /** Maximum entries to return */
  limit?: number;
}

/** Result of a sync operation */
export interface SyncResult {
  /** Sync direction that was performed */
  mode: SyncMode;
  /** Number of entries pulled from JackClaw */
  pulled: number;
  /** Number of entries pushed to JackClaw */
  pushed: number;
  /** Number of conflicts detected */
  conflicts: number;
  /** Errors encountered during sync */
  errors: SyncError[];
  /** Timestamp of sync completion */
  timestamp: number;
}

/** Sync error details */
export interface SyncError {
  /** Entry ID that caused error (if applicable) */
  entryId?: string;
  /** Error message */
  message: string;
  /** Error type */
  type: 'read' | 'write' | 'transform' | 'conflict';
}

/** Adapter configuration */
export interface MemoryAdapterConfig {
  /** Path to JackClaw memory directory */
  memoryPath: string;
  /** Default sync mode */
  defaultMode: SyncMode;
  /** Auto-sync interval in ms (0 = disabled) */
  autoSyncInterval: number;
  /** Maximum entries to sync per operation */
  maxBatchSize: number;
  /** Default expiration for new entries (ms, 0 = never) */
  defaultTtl: number;
}

// ============================================================================
// Memory Adapter Implementation
// ============================================================================

export class JackClawMemoryAdapter {
  private config: MemoryAdapterConfig;
  private lastSyncTime: number = 0;

  constructor(config: MemoryAdapterConfig) {
    this.config = {
      defaultMode: 'bidirectional',
      autoSyncInterval: 0,
      maxBatchSize: 100,
      defaultTtl: 0,
      ...config,
    };
  }

  /**
   * Pull memory entries from JackClaw into JackCode context fragments
   */
  async pull(query: MemoryQuery): Promise<ContextFragment[]> {
    const entries = await this.queryMemory(query);
    return entries.map(entry => this.entryToFragment(entry));
  }

  /**
   * Push JackCode context fragments to JackClaw memory
   */
  async push(fragments: ContextFragment[], sessionId: string): Promise<SyncResult> {
    const entries = fragments.map(f => this.fragmentToEntry(f, sessionId));
    const result: SyncResult = {
      mode: 'push',
      pulled: 0,
      pushed: 0,
      conflicts: 0,
      errors: [],
      timestamp: Date.now(),
    };

    for (const entry of entries) {
      try {
        await this.writeEntry(entry);
        result.pushed++;
      } catch (err) {
        result.errors.push({
          entryId: entry.id,
          message: err instanceof Error ? err.message : String(err),
          type: 'write',
        });
      }
    }

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

    // Pull remote entries
    try {
      const remoteEntries = await this.queryMemory({ sessionId, limit: this.config.maxBatchSize });
      const remoteFragments = remoteEntries.map(e => this.entryToFragment(e));
      result.pulled = remoteFragments.length;
    } catch (err) {
      result.errors.push({
        message: err instanceof Error ? err.message : String(err),
        type: 'read',
      });
    }

    // Push local fragments
    const entries = localFragments.map(f => this.fragmentToEntry(f, sessionId));
    for (const entry of entries) {
      try {
        await this.writeEntry(entry);
        result.pushed++;
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
   * @todo Implement actual filesystem read from JackClaw memory directory
   */
  private async queryMemory(query: MemoryQuery): Promise<MemoryEntry[]> {
    // Placeholder: Read from JackClaw memory files
    // Implementation would scan memory/ directory and parse markdown files
    return [];
  }

  /**
   * Write entry to JackClaw memory storage
   * @todo Implement actual filesystem write
   */
  private async writeEntry(entry: MemoryEntry): Promise<void> {
    // Placeholder: Write to JackClaw memory files
    // Implementation would append to appropriate memory/YYYY-MM-DD.md file
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
      type: typeMap[entry.type] || 'doc',
      content: entry.content,
      source: entry.metadata.source,
      timestamp: entry.timestamp,
      metadata: {
        accessCount: 0,
        lastAccess: entry.timestamp,
        priority: entry.metadata.priority,
        tags: entry.metadata.tags,
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
        tags: fragment.metadata.tags,
        source: fragment.source,
        priority: fragment.metadata.priority,
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
    return typeMap[fragmentType] || 'learning';
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

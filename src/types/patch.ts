/**
 * Patch Engine Types
 * Core type definitions for patch planning, diff summaries, and rollback support.
 */

/** Represents a single change request */
export interface ChangeRequest {
  /** Target file path */
  targetPath: string;
  /** Description of intended change */
  description: string;
  /** Optional: specific line range to modify */
  range?: LineRange;
  /** Optional: replacement content */
  replacement?: string;
  /** Optional: insertion content */
  insertion?: string;
}

/** Line range within a file */
export interface LineRange {
  start: number;
  end: number;
}

/** A planned patch with metadata */
export interface PatchPlan {
  /** Unique identifier */
  id: string;
  /** Timestamp of creation */
  createdAt: number;
  /** Ordered list of patches to apply */
  patches: Patch[];
  /** Estimated impact summary */
  impact: ImpactSummary;
  /** Optional dependency graph between patch ids */
  dependencies?: Record<string, string[]>;
}

/** Individual patch unit */
export interface Patch {
  /** Unique identifier */
  id: string;
  /** Target file path */
  targetPath: string;
  /** Diff hunks to apply */
  hunks: Hunk[];
  /** Original file checksum (for verification) */
  originalChecksum: string;
  /** Reverse patch for rollback */
  reversePatch: ReversePatch;
}

/** A hunk of changes */
export interface Hunk {
  /** Old line range */
  oldRange: LineRange;
  /** New line range */
  newRange: LineRange;
  /** Context lines before change */
  contextBefore: string[];
  /** Removed lines (prefixed with -) */
  removedLines: string[];
  /** Added lines (prefixed with +) */
  addedLines: string[];
  /** Context lines after change */
  contextAfter: string[];
}

/** Reverse patch for rollback */
export interface ReversePatch {
  /** Stored at path */
  storagePath: string;
  /** Checksum of reverse patch */
  checksum: string;
}

/** Impact analysis summary */
export interface ImpactSummary {
  /** Files affected */
  filesAffected: number;
  /** Lines added */
  linesAdded: number;
  /** Lines removed */
  linesRemoved: number;
  /** Estimated risk level */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  /** Dependencies that may be affected */
  affectedDependencies?: string[];
}

/** Result of applying a patch plan */
export interface PatchResult {
  /** Whether application succeeded */
  success: boolean;
  /** Applied patches */
  applied: Patch[];
  /** Failed patches (if any) */
  failed?: FailedPatch[];
  /** Rollback availability */
  canRollback: boolean;
}

/** Failed patch information */
export interface FailedPatch {
  patch: Patch;
  /** Error details */
  error: string;
  /** Type of failure */
  failureType: 'checksum_mismatch' | 'conflict' | 'io_error' | 'permission_denied';
}

/** Result of rollback operation */
export interface RollbackResult {
  /** Whether rollback succeeded */
  success: boolean;
  /** Patches rolled back */
  rolledBack: string[];
  /** Errors during rollback */
  errors?: RollbackError[];
}

/** Rollback error details */
export interface RollbackError {
  patchId: string;
  error: string;
}

/** Human-readable diff summary */
export interface DiffSummary {
  /** Overview description */
  overview: string;
  /** Per-file summaries */
  fileSummaries: FileSummary[];
  /** Statistics */
  stats: DiffStats;
}

/** Summary for a single file */
export interface FileSummary {
  path: string;
  /** Type of change */
  changeType: 'added' | 'modified' | 'deleted';
  /** Brief description of changes */
  description: string;
  /** Complexity score (1-10) */
  complexity: number;
}

/** Diff statistics */
export interface DiffStats {
  filesChanged: number;
  insertions: number;
  deletions: number;
}

/** Patch engine configuration */
export interface PatchEngineConfig {
  /** Snapshot retention in days */
  snapshotRetentionDays: number;
  /** Maximum patch size in lines */
  maxPatchSize: number;
  /** Enable syntax-aware diffs */
  syntaxAware: boolean;
  /** Snapshot storage directory */
  snapshotDir: string;
}

/** Patch history entry */
export interface PatchHistoryEntry {
  id: string;
  /** Timestamp */
  timestamp: number;
  /** Action type */
  action: 'planned' | 'applied' | 'rolled_back' | 'failed' | 'verified';
  /** Related session ID */
  sessionId?: string;
}

export interface PatchContextFragment {
  id: string;
  type: 'code' | 'system';
  content: string;
  source?: string;
  timestamp: number;
  metadata: {
    accessCount: number;
    lastAccess: number;
    priority: number;
    tags: string[];
  };
}

export interface PatchVerificationResult {
  success: boolean;
  stage: 'build' | 'test' | 'build-test';
  output: string;
  errors: string[];
}

export interface PatchLifecycleEvent {
  type:
    | 'patch:started'
    | 'patch:applied'
    | 'patch:failed'
    | 'patch:verified'
    | 'patch:rolled-back'
    | 'patch:cancelled';
  patchId?: string;
  planId?: string;
  timestamp: number;
  detail?: Record<string, unknown>;
}

export interface PatchRuntimeAdapter {
  emit?(event: string, payload: Record<string, unknown>): void;
  isCancellationRequested?(): boolean;
}

export interface PatchSessionAdapter {
  addContextFragment?(sessionId: string, fragment: PatchContextFragment, taskId?: string): boolean;
  getSession?(sessionId: string): { currentTask?: { id: string | null } | null } | undefined;
}

export interface PatchScannerAdapter {
  getIndex?(): { files: Map<string, { path: string; absolutePath: string }> } | null;
  searchFiles?(pattern: string): Array<{ path: string; absolutePath: string }>;
  scanIncremental?(changes: Array<{ path: string; type: 'added' | 'modified' | 'deleted' }>): Promise<unknown>;
  refresh?(): Promise<unknown>;
}

export interface PatchSymbolIndexAdapter {
  updateFile?(filePath: string): Promise<void>;
  removeFile?(filePath: string): void;
}

export interface PatchBuildAdapter {
  build?(): Promise<{ success: boolean; output: string; errors: string[] }>;
  test?(): Promise<{ success: boolean; output: string; errors: string[] }>;
  run?(options?: Record<string, unknown>): Promise<{ success: boolean; output: string; errors: string[] }>;
}

export interface PatchApplyOptions {
  sessionId?: string;
  runtime?: PatchRuntimeAdapter;
  session?: PatchSessionAdapter;
  scanner?: PatchScannerAdapter;
  symbolIndex?: PatchSymbolIndexAdapter;
  build?: PatchBuildAdapter;
  autoVerify?: boolean;
  taskId?: string;
  onPatchApplied?(patch: Patch): void | Promise<void>;
  onPatchFailed?(failed: FailedPatch): void | Promise<void>;
}

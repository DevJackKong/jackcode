/**
 * Patch Engine
 * Planning, diff generation, and rollback support for code changes.
 */

import {
  ChangeRequest,
  PatchPlan,
  Patch,
  Hunk,
  PatchResult,
  RollbackResult,
  DiffSummary,
  FileSummary,
  DiffStats,
  ImpactSummary,
  FailedPatch,
  PatchEngineConfig,
  PatchHistoryEntry,
  LineRange,
  ReversePatch,
} from '../types/patch.js';

/** Default configuration */
const DEFAULT_CONFIG: PatchEngineConfig = {
  snapshotRetentionDays: 30,
  maxPatchSize: 10000,
  syntaxAware: true,
  snapshotDir: '.jackcode/snapshots',
};

/** In-memory patch history (persisted via session context) */
const patchHistory: PatchHistoryEntry[] = [];

/** Active snapshots for rollback */
const activeSnapshots = new Map<string, ReversePatch>();

/**
 * Generate unique ID for patches
 */
function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Compute simple checksum for content verification
 */
function computeChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(16);
}

/**
 * Create a patch plan from change requests
 */
export function planPatches(
  changes: ChangeRequest[],
  config: Partial<PatchEngineConfig> = {}
): PatchPlan {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const patches: Patch[] = [];
  
  let totalAdded = 0;
  let totalRemoved = 0;
  const affectedFiles = new Set<string>();

  for (const change of changes) {
    affectedFiles.add(change.targetPath);
    
    // Create patch from change request
    const patch = createPatchFromRequest(change, mergedConfig);
    patches.push(patch);
    
    // Accumulate stats
    for (const hunk of patch.hunks) {
      totalAdded += hunk.addedLines.length;
      totalRemoved += hunk.removedLines.length;
    }
  }

  // Assess risk level based on change magnitude
  const riskLevel = assessRiskLevel(totalAdded, totalRemoved, affectedFiles.size);

  const plan: PatchPlan = {
    id: generateId('plan'),
    createdAt: Date.now(),
    patches,
    impact: {
      filesAffected: affectedFiles.size,
      linesAdded: totalAdded,
      linesRemoved: totalRemoved,
      riskLevel,
    },
  };

  // Log plan creation
  patchHistory.push({
    id: plan.id,
    timestamp: plan.createdAt,
    action: 'planned',
  });

  return plan;
}

/**
 * Create a patch from a change request
 */
function createPatchFromRequest(
  request: ChangeRequest,
  config: PatchEngineConfig
): Patch {
  const patchId = generateId('patch');
  
  // Build hunk from change request
  const hunk: Hunk = {
    oldRange: request.range ?? { start: 0, end: 0 },
    newRange: calculateNewRange(request),
    contextBefore: [],
    removedLines: request.replacement ? ['// original'] : [],
    addedLines: request.replacement?.split('\n') ?? request.insertion?.split('\n') ?? [],
    contextAfter: [],
  };

  // Create reverse patch placeholder
  const reversePatch: ReversePatch = {
    storagePath: `${config.snapshotDir}/${patchId}.rev`,
    checksum: '', // computed during apply
  };

  return {
    id: patchId,
    targetPath: request.targetPath,
    hunks: [hunk],
    originalChecksum: '', // filled during apply
    reversePatch,
  };
}

/**
 * Calculate new line range after changes
 */
function calculateNewRange(request: ChangeRequest): LineRange {
  const addedLines = request.replacement?.split('\n').length ?? 
                    request.insertion?.split('\n').length ?? 0;
  const start = request.range?.start ?? 0;
  
  return {
    start,
    end: start + addedLines,
  };
}

/**
 * Assess risk level based on change metrics
 */
function assessRiskLevel(
  linesAdded: number,
  linesRemoved: number,
  filesAffected: number
): 'low' | 'medium' | 'high' | 'critical' {
  const totalChanges = linesAdded + linesRemoved;
  
  if (totalChanges > 500 || filesAffected > 10) return 'critical';
  if (totalChanges > 200 || filesAffected > 5) return 'high';
  if (totalChanges > 50 || filesAffected > 2) return 'medium';
  return 'low';
}

/**
 * Apply a patch plan
 * Stub implementation - full implementation needs file system access
 */
export async function applyPatch(
  plan: PatchPlan,
  sessionId?: string
): Promise<PatchResult> {
  const applied: Patch[] = [];
  const failed: FailedPatch[] = [];

  // Sort patches by target path for deterministic application
  const sortedPatches = [...plan.patches].sort((a, b) => 
    a.targetPath.localeCompare(b.targetPath)
  );

  for (const patch of sortedPatches) {
    try {
      // Store reverse patch for rollback
      activeSnapshots.set(patch.id, patch.reversePatch);
      applied.push(patch);
    } catch (error) {
      failed.push({
        patch,
        error: String(error),
        failureType: 'io_error',
      });
    }
  }

  const success = failed.length === 0;
  const timestamp = Date.now();

  // Log application
  for (const patch of applied) {
    patchHistory.push({
      id: patch.id,
      timestamp,
      action: 'applied',
      sessionId,
    });
  }

  return {
    success,
    applied,
    failed: failed.length > 0 ? failed : undefined,
    canRollback: applied.length > 0,
  };
}

/**
 * Rollback a patch by ID
 * Stub implementation - full implementation needs file system access
 */
export async function rollbackPatch(patchId: string): Promise<RollbackResult> {
  const reversePatch = activeSnapshots.get(patchId);
  const rolledBack: string[] = [];
  const errors: { patchId: string; error: string }[] = [];

  if (!reversePatch) {
    return {
      success: false,
      rolledBack,
      errors: [{ patchId, error: 'No snapshot found for patch' }],
    };
  }

  try {
    // Apply reverse patch (stub)
    activeSnapshots.delete(patchId);
    rolledBack.push(patchId);

    // Log rollback
    patchHistory.push({
      id: patchId,
      timestamp: Date.now(),
      action: 'rolled_back',
    });
  } catch (error) {
    errors.push({ patchId, error: String(error) });
  }

  return {
    success: errors.length === 0,
    rolledBack,
    errors: errors.length > 0 ? errors : undefined,
  };
}

/**
 * Generate a human-readable diff summary
 */
export function summarizeDiff(patches: Patch[]): DiffSummary {
  const fileSummaries: FileSummary[] = [];
  let totalInsertions = 0;
  let totalDeletions = 0;
  const changedFiles = new Set<string>();

  for (const patch of patches) {
    changedFiles.add(patch.targetPath);
    
    let fileInsertions = 0;
    let fileDeletions = 0;
    
    for (const hunk of patch.hunks) {
      fileInsertions += hunk.addedLines.length;
      fileDeletions += hunk.removedLines.length;
    }
    
    totalInsertions += fileInsertions;
    totalDeletions += fileDeletions;

    // Determine change type
    const changeType: FileSummary['changeType'] = 
      fileDeletions === 0 ? 'added' : 
      fileInsertions === 0 ? 'deleted' : 'modified';

    // Calculate complexity (1-10)
    const complexity = Math.min(10, Math.ceil(
      (fileInsertions + fileDeletions) / 10
    ));

    fileSummaries.push({
      path: patch.targetPath,
      changeType,
      description: generateChangeDescription(changeType, fileInsertions, fileDeletions),
      complexity,
    });
  }

  const stats: DiffStats = {
    filesChanged: changedFiles.size,
    insertions: totalInsertions,
    deletions: totalDeletions,
  };

  return {
    overview: generateOverview(stats),
    fileSummaries,
    stats,
  };
}

/**
 * Generate description for a file change
 */
function generateChangeDescription(
  changeType: FileSummary['changeType'],
  insertions: number,
  deletions:
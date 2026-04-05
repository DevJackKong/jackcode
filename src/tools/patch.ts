/**
 * Patch Engine
 * Planning, diff generation, and rollback support for code changes.
 */

import {
  type ChangeRequest,
  type PatchPlan,
  type Patch,
  type Hunk,
  type PatchResult,
  type RollbackResult,
  type DiffSummary,
  type FileSummary,
  type DiffStats,
  type FailedPatch,
  type PatchEngineConfig,
  type PatchHistoryEntry,
  type LineRange,
  type ReversePatch,
} from '../types/patch.js';

const DEFAULT_CONFIG: PatchEngineConfig = {
  snapshotRetentionDays: 30,
  maxPatchSize: 10000,
  syntaxAware: true,
  snapshotDir: '.jackcode/snapshots',
};

const patchHistory: PatchHistoryEntry[] = [];
const activeSnapshots = new Map<string, ReversePatch>();

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
}

function computeChecksum(content: string): string {
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash + char) | 0;
  }
  return hash.toString(16);
}

export function planPatches(
  changes: ChangeRequest[],
  config: Partial<PatchEngineConfig> = {}
): PatchPlan {
  const mergedConfig: PatchEngineConfig = { ...DEFAULT_CONFIG, ...config };
  const patches: Patch[] = [];

  let totalAdded = 0;
  let totalRemoved = 0;
  const affectedFiles = new Set<string>();

  for (const change of changes) {
    if (!change.targetPath.trim()) {
      throw new Error('Change request targetPath is required');
    }

    affectedFiles.add(change.targetPath);
    const patch = createPatchFromRequest(change, mergedConfig);
    patches.push(patch);

    for (const hunk of patch.hunks) {
      totalAdded += hunk.addedLines.length;
      totalRemoved += hunk.removedLines.length;
    }
  }

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

  patchHistory.push({
    id: plan.id,
    timestamp: plan.createdAt,
    action: 'planned',
  });

  return plan;
}

function createPatchFromRequest(
  request: ChangeRequest,
  config: PatchEngineConfig
): Patch {
  const patchId = generateId('patch');
  const nextContent = request.replacement ?? request.insertion ?? '';
  const addedLines = splitLines(nextContent);
  const removedLines = request.replacement && request.range ? [`range:${request.range.start}-${request.range.end}`] : [];

  const hunk: Hunk = {
    oldRange: normalizeOldRange(request.range),
    newRange: calculateNewRange(request),
    contextBefore: [],
    removedLines,
    addedLines,
    contextAfter: [],
  };

  const reversePatch: ReversePatch = {
    storagePath: `${config.snapshotDir}/${patchId}.rev`,
    checksum: computeChecksum(JSON.stringify({ targetPath: request.targetPath, hunk })),
  };

  return {
    id: patchId,
    targetPath: request.targetPath,
    hunks: [hunk],
    originalChecksum: computeChecksum(request.targetPath),
    reversePatch,
  };
}

function normalizeOldRange(range?: LineRange): LineRange {
  if (!range) {
    return { start: 1, end: 1 };
  }

  const start = Math.max(1, range.start);
  const end = Math.max(start, range.end);
  return { start, end };
}

function calculateNewRange(request: ChangeRequest): LineRange {
  const lineCount = splitLines(request.replacement ?? request.insertion ?? '').length;
  const start = request.range?.start ? Math.max(1, request.range.start) : 1;
  const safeLineCount = Math.max(lineCount, 1);

  return {
    start,
    end: start + safeLineCount - 1,
  };
}

function splitLines(content: string): string[] {
  if (!content) {
    return [];
  }
  return content.split('\n');
}

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

export async function applyPatch(
  plan: PatchPlan,
  sessionId?: string
): Promise<PatchResult> {
  const applied: Patch[] = [];
  const failed: FailedPatch[] = [];

  const sortedPatches = [...plan.patches].sort((a, b) => a.targetPath.localeCompare(b.targetPath));

  for (const patch of sortedPatches) {
    try {
      activeSnapshots.set(patch.id, patch.reversePatch);
      applied.push(patch);
    } catch (error) {
      failed.push({
        patch,
        error: error instanceof Error ? error.message : String(error),
        failureType: 'io_error',
      });
    }
  }

  const timestamp = Date.now();
  for (const patch of applied) {
    patchHistory.push({
      id: patch.id,
      timestamp,
      action: 'applied',
      sessionId,
    });
  }

  return {
    success: failed.length === 0,
    applied,
    failed: failed.length > 0 ? failed : undefined,
    canRollback: applied.length > 0,
  };
}

export async function rollbackPatch(patchId: string): Promise<RollbackResult> {
  const reversePatch = activeSnapshots.get(patchId);
  const rolledBack: string[] = [];
  const errors: Array<{ patchId: string; error: string }> = [];

  if (!reversePatch) {
    return {
      success: false,
      rolledBack,
      errors: [{ patchId, error: 'No snapshot found for patch' }],
    };
  }

  try {
    activeSnapshots.delete(patchId);
    rolledBack.push(patchId);
    patchHistory.push({
      id: patchId,
      timestamp: Date.now(),
      action: 'rolled_back',
    });
  } catch (error) {
    errors.push({
      patchId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return {
    success: errors.length === 0,
    rolledBack,
    errors: errors.length > 0 ? errors : undefined,
  };
}

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

    const changeType: FileSummary['changeType'] =
      fileInsertions > 0 && fileDeletions === 0
        ? 'added'
        : fileInsertions === 0 && fileDeletions > 0
          ? 'deleted'
          : 'modified';

    const complexity = Math.max(1, Math.min(10, Math.ceil((fileInsertions + fileDeletions) / 10)));

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

function generateChangeDescription(
  changeType: FileSummary['changeType'],
  insertions: number,
  deletions: number
): string {
  switch (changeType) {
    case 'added':
      return `Added ${insertions} line${insertions !== 1 ? 's' : ''}`;
    case 'deleted':
      return `Deleted ${deletions} line${deletions !== 1 ? 's' : ''}`;
    case 'modified':
      return `Modified (${insertions} added, ${deletions} removed)`;
  }
}

function generateOverview(stats: DiffStats): string {
  const { filesChanged, insertions, deletions } = stats;
  const fileWord = filesChanged === 1 ? 'file' : 'files';

  if (insertions === 0 && deletions === 0) {
    return `No changes in ${filesChanged} ${fileWord}`;
  }

  const parts: string[] = [];
  if (insertions > 0) parts.push(`${insertions} insertion${insertions !== 1 ? 's' : ''}`);
  if (deletions > 0) parts.push(`${deletions} deletion${deletions !== 1 ? 's' : ''}`);

  return `${filesChanged} ${fileWord} changed, ${parts.join(', ')}`;
}

export function getPatchHistory(): readonly PatchHistoryEntry[] {
  return Object.freeze([...patchHistory]);
}

export function canRollback(patchId: string): boolean {
  return activeSnapshots.has(patchId);
}

export function getActiveSnapshotIds(): string[] {
  return Array.from(activeSnapshots.keys());
}

export function cleanupSnapshots(maxAgeDays?: number): string[] {
  const retentionMs = (maxAgeDays ?? DEFAULT_CONFIG.snapshotRetentionDays) * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - retentionMs;
  const removed: string[] = [];

  for (const [id] of activeSnapshots) {
    const historyEntry = patchHistory.find((entry) => entry.id === id);
    if (historyEntry && historyEntry.timestamp < cutoff) {
      activeSnapshots.delete(id);
      removed.push(id);
    }
  }

  return removed;
}

export function generateUnifiedDiff(patch: Patch): string {
  const lines: string[] = [];
  lines.push(`--- a/${patch.targetPath}`);
  lines.push(`+++ b/${patch.targetPath}`);

  for (const hunk of patch.hunks) {
    const oldCount = Math.max(0, hunk.oldRange.end - hunk.oldRange.start + 1);
    const newCount = Math.max(0, hunk.newRange.end - hunk.newRange.start + 1);
    lines.push(`@@ -${hunk.oldRange.start},${oldCount} +${hunk.newRange.start},${newCount} @@`);

    for (const line of hunk.contextBefore) {
      lines.push(` ${line}`);
    }
    for (const line of hunk.removedLines) {
      lines.push(`-${line}`);
    }
    for (const line of hunk.addedLines) {
      lines.push(`+${line}`);
    }
    for (const line of hunk.contextAfter) {
      lines.push(` ${line}`);
    }
  }

  return lines.join('\n');
}

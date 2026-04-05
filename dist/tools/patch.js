/**
 * Patch Engine
 * Planning, diff generation, application, verification, and rollback support.
 */
import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants, promises as fs } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
const DEFAULT_CONFIG = {
    snapshotRetentionDays: 30,
    maxPatchSize: 10000,
    syntaxAware: true,
    snapshotDir: '.jackcode/snapshots',
};
const MAX_CONTEXT_LINES = 3;
const MAX_FUZZ_OFFSET = 8;
const LARGE_FILE_LINE_THRESHOLD = 5000;
const patchHistory = [];
const activeSnapshots = new Map();
const patchContexts = new Map();
const patchDependencyGraph = new Map();
function generateId(prefix) {
    return `${prefix}_${Date.now()}_${randomUUID().slice(0, 8)}`;
}
function computeChecksum(content) {
    return createHash('sha256').update(content).digest('hex');
}
function normalizePath(input) {
    return isAbsolute(input) ? input : resolve(input);
}
function emitLifecycleEvent(events, type, detail, ids) {
    events.push({ type, detail, timestamp: Date.now(), patchId: ids?.patchId, planId: ids?.planId });
}
function makeContextFragment(patch) {
    return {
        id: `patch-context-${patch.id}`,
        type: 'code',
        content: generateUnifiedDiff(patch),
        source: patch.targetPath,
        timestamp: Date.now(),
        metadata: {
            accessCount: 0,
            lastAccess: Date.now(),
            priority: 5,
            tags: ['patch', 'diff'],
        },
    };
}
async function verifyWithBuildAdapters(patches, options) {
    if (options.autoVerify === false || !options.build)
        return null;
    const outputs = [];
    const errors = [];
    if (typeof options.build.run === 'function') {
        const result = await options.build.run({ patches: patches.map((patch) => patch.id) });
        if (result.output)
            outputs.push(result.output);
        if (result.errors?.length)
            errors.push(...result.errors);
        return {
            success: result.success,
            stage: 'build-test',
            output: outputs.join('\n'),
            errors,
        };
    }
    let stage = 'build-test';
    let success = true;
    if (typeof options.build.build === 'function') {
        const buildResult = await options.build.build();
        if (buildResult.output)
            outputs.push(buildResult.output);
        if (buildResult.errors?.length)
            errors.push(...buildResult.errors);
        if (!buildResult.success) {
            success = false;
            stage = 'build';
        }
    }
    if (success && typeof options.build.test === 'function') {
        const testResult = await options.build.test();
        if (testResult.output)
            outputs.push(testResult.output);
        if (testResult.errors?.length)
            errors.push(...testResult.errors);
        if (!testResult.success) {
            success = false;
            stage = typeof options.build.build === 'function' ? 'build-test' : 'test';
        }
    }
    return {
        success,
        stage,
        output: outputs.join('\n'),
        errors,
    };
}
function splitLines(content) {
    if (content.length === 0) {
        return [];
    }
    return content.split('\n');
}
function joinLines(lines) {
    return lines.join('\n');
}
function normalizeRange(range, lineCount) {
    if (!range) {
        return { start: 1, end: Math.max(1, lineCount) };
    }
    const start = Math.max(1, range.start);
    const end = Math.max(start, range.end);
    return { start, end };
}
function countChangedLines(hunk) {
    return {
        added: hunk.addedLines.length,
        removed: hunk.removedLines.length,
    };
}
function estimateComplexity(insertions, deletions, context) {
    const raw = insertions + deletions + Math.ceil(context / 2);
    return Math.max(1, Math.min(10, Math.ceil(raw / 10)));
}
function assessRiskLevel(linesAdded, linesRemoved, filesAffected) {
    const totalChanges = linesAdded + linesRemoved;
    if (totalChanges > 500 || filesAffected > 10)
        return 'critical';
    if (totalChanges > 200 || filesAffected > 5)
        return 'high';
    if (totalChanges > 50 || filesAffected > 2)
        return 'medium';
    return 'low';
}
function detectChangeType(beforeExists, afterExists, afterLines, removedLines) {
    if (!beforeExists && afterExists)
        return 'added';
    if (beforeExists && !afterExists)
        return 'deleted';
    if (afterLines.length > 0 && removedLines.length === 0)
        return 'added';
    if (afterLines.length === 0 && removedLines.length > 0)
        return 'deleted';
    return 'modified';
}
function toMetadata(patch) {
    return (patch.metadata ?? {});
}
function setMetadata(patch, metadata) {
    patch.metadata = metadata;
}
async function readFileState(targetPath) {
    const absolutePath = normalizePath(targetPath);
    try {
        const stat = await fs.stat(absolutePath);
        const buffer = await fs.readFile(absolutePath);
        const isBinary = detectBinary(buffer, absolutePath);
        if (isBinary) {
            return {
                exists: true,
                content: '',
                lines: [],
                isBinary: true,
                mode: stat.mode,
            };
        }
        const content = buffer.toString('utf8');
        return {
            exists: true,
            content,
            lines: splitLines(content),
            isBinary: false,
            mode: stat.mode,
        };
    }
    catch (error) {
        const code = error.code;
        if (code === 'ENOENT') {
            return {
                exists: false,
                content: '',
                lines: [],
                isBinary: false,
            };
        }
        throw error;
    }
}
function detectBinary(buffer, filePath) {
    const lower = filePath.toLowerCase();
    const binaryExtensions = [
        '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico',
        '.pdf', '.zip', '.tar', '.gz', '.tgz', '.rar', '.7z',
        '.mp3', '.mp4', '.mov', '.wav', '.ogg', '.webm',
        '.exe', '.dll', '.so', '.dylib', '.wasm', '.class',
    ];
    if (binaryExtensions.some((ext) => lower.endsWith(ext))) {
        return true;
    }
    const sampleSize = Math.min(buffer.length, 8192);
    for (let index = 0; index < sampleSize; index++) {
        if (buffer[index] === 0) {
            return true;
        }
    }
    return false;
}
function createPatchFromStates(request, before, afterContent, config) {
    const patchId = generateId('patch');
    const beforeLines = before.lines;
    const range = request.range
        ? normalizeRange(request.range, beforeLines.length)
        : inferAffectedRange(beforeLines, request, splitLines(afterContent));
    const startIndex = Math.max(0, range.start - 1);
    const endIndexExclusive = Math.min(beforeLines.length, Math.max(startIndex, range.end));
    const removedLines = beforeLines.slice(startIndex, endIndexExclusive);
    const contextBefore = beforeLines.slice(Math.max(0, startIndex - MAX_CONTEXT_LINES), startIndex);
    const contextAfter = beforeLines.slice(endIndexExclusive, Math.min(beforeLines.length, endIndexExclusive + MAX_CONTEXT_LINES));
    let addedLines;
    if (request.range) {
        addedLines = request.replacement !== undefined
            ? splitLines(request.replacement)
            : request.insertion !== undefined
                ? splitLines(request.insertion)
                : [];
    }
    else if (request.insertion !== undefined) {
        addedLines = splitLines(request.insertion);
    }
    else if (request.replacement !== undefined && beforeLines.length > 0) {
        addedLines = splitLines(request.replacement);
    }
    else {
        addedLines = splitLines(afterContent);
    }
    const newBodyStart = Math.max(1, range.start);
    const newBodyEnd = addedLines.length === 0 ? Math.max(newBodyStart - 1, 0) : newBodyStart + addedLines.length - 1;
    const hunk = {
        oldRange: {
            start: removedLines.length === 0 ? range.start : range.start,
            end: removedLines.length === 0 ? Math.max(range.start - 1, 0) : range.end,
        },
        newRange: {
            start: addedLines.length === 0 ? Math.max(newBodyStart - 1, 0) : newBodyStart,
            end: newBodyEnd,
        },
        contextBefore,
        removedLines,
        addedLines,
        contextAfter,
    };
    const patch = {
        id: patchId,
        targetPath: request.targetPath,
        hunks: [hunk],
        originalChecksum: computeChecksum(before.content),
        reversePatch: {
            storagePath: join(config.snapshotDir, `${patchId}.json`),
            checksum: computeChecksum(`${request.targetPath}:${before.content}:${afterContent}`),
        },
    };
    const changeType = detectChangeType(before.exists, afterContent.length > 0, addedLines, removedLines);
    const complexity = estimateComplexity(addedLines.length, removedLines.length, contextBefore.length + contextAfter.length);
    const riskLevel = assessRiskLevel(addedLines.length, removedLines.length, 1);
    const verification = validatePatchContent(request.targetPath, afterContent, config.syntaxAware);
    setMetadata(patch, {
        description: request.description,
        changeType,
        complexity,
        riskLevel,
        impactScore: Math.min(100, (addedLines.length + removedLines.length) * 2 + complexity * 3),
        binary: before.isBinary,
        largeFile: before.lines.length > LARGE_FILE_LINE_THRESHOLD || addedLines.length > LARGE_FILE_LINE_THRESHOLD,
        verification,
    });
    return patch;
}
function inferAffectedRange(beforeLines, request, afterLines) {
    if (!beforeLines.length) {
        return { start: 1, end: 0 };
    }
    if (request.replacement !== undefined) {
        const replacementLines = splitLines(request.replacement);
        const matchIndex = replacementLines.length > 0 ? findExactSequence(beforeLines, replacementLines) : -1;
        if (matchIndex >= 0) {
            return { start: matchIndex + 1, end: matchIndex + replacementLines.length };
        }
    }
    if (request.insertion !== undefined) {
        return { start: beforeLines.length + 1, end: beforeLines.length };
    }
    return {
        start: 1,
        end: Math.min(beforeLines.length, Math.max(1, afterLines.length)),
    };
}
function findExactSequence(source, needle) {
    if (needle.length === 0) {
        return 0;
    }
    outer: for (let i = 0; i <= source.length - needle.length; i++) {
        for (let j = 0; j < needle.length; j++) {
            if (source[i + j] !== needle[j]) {
                continue outer;
            }
        }
        return i;
    }
    return -1;
}
function applyChangeRequestToContent(before, request) {
    const lines = [...before.lines];
    if (request.range) {
        const safeRange = normalizeRange(request.range, lines.length);
        const startIndex = Math.max(0, safeRange.start - 1);
        const deleteCount = Math.max(0, safeRange.end - safeRange.start + 1);
        const replacementLines = request.replacement !== undefined
            ? splitLines(request.replacement)
            : request.insertion !== undefined
                ? splitLines(request.insertion)
                : [];
        lines.splice(startIndex, deleteCount, ...replacementLines);
        return joinLines(lines);
    }
    if (request.replacement !== undefined) {
        if (before.content.includes(request.description) && !before.content.includes(request.replacement)) {
            return before.content.replace(request.description, request.replacement);
        }
        const replacementLines = splitLines(request.replacement);
        const matchIndex = replacementLines.length > 0 ? findExactSequence(lines, replacementLines) : -1;
        if (matchIndex >= 0) {
            lines.splice(matchIndex, replacementLines.length, ...replacementLines);
            return joinLines(lines);
        }
        if (before.content.includes(request.replacement)) {
            return before.content;
        }
    }
    if (request.insertion !== undefined) {
        if (before.content.length === 0) {
            return request.insertion;
        }
        return before.content.endsWith('\n')
            ? `${before.content}${request.insertion}`
            : `${before.content}\n${request.insertion}`;
    }
    return before.content;
}
function validatePatchContent(filePath, content, syntaxAware) {
    const errors = [];
    if (!syntaxAware || content.length === 0) {
        return { valid: true, errors };
    }
    const lower = filePath.toLowerCase();
    try {
        if (lower.endsWith('.json')) {
            JSON.parse(content);
        }
        else if (lower.endsWith('.cjs')) {
            // eslint-disable-next-line no-new-func
            new Function(content);
        }
    }
    catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
    }
    return { valid: errors.length === 0, errors };
}
async function ensureDir(path) {
    await fs.mkdir(path, { recursive: true });
}
async function createLock(targetPath) {
    const absolutePath = normalizePath(targetPath);
    const lockPath = `${absolutePath}.jackcode.lock`;
    const handle = await fs.open(lockPath, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY, 0o600);
    await handle.writeFile(`${process.pid}:${Date.now()}`);
    await handle.close();
    return lockPath;
}
async function releaseLock(lockPath) {
    await fs.rm(lockPath, { force: true });
}
async function writeAtomic(targetPath, content, mode) {
    const absolutePath = normalizePath(targetPath);
    await ensureDir(dirname(absolutePath));
    const tempPath = join(dirname(absolutePath), `.${basename(absolutePath)}.${randomUUID()}.tmp`);
    await fs.writeFile(tempPath, content, 'utf8');
    if (typeof mode === 'number') {
        await fs.chmod(tempPath, mode & 0o777);
    }
    await fs.rename(tempPath, absolutePath);
}
async function createBackup(targetPath, content) {
    const absolutePath = normalizePath(targetPath);
    const backupDir = join(dirname(absolutePath), '.jackcode-backups');
    await ensureDir(backupDir);
    const backupPath = join(backupDir, `${basename(absolutePath)}.${Date.now()}.bak`);
    await fs.writeFile(backupPath, content, 'utf8');
    return backupPath;
}
async function storeReversePatch(snapshot, payload) {
    const absolutePath = normalizePath(snapshot.storagePath);
    await ensureDir(dirname(absolutePath));
    await fs.writeFile(absolutePath, JSON.stringify(payload, null, 2), 'utf8');
}
async function loadReversePatch(snapshot) {
    const content = await fs.readFile(normalizePath(snapshot.storagePath), 'utf8');
    return JSON.parse(content);
}
function formatUnifiedRange(range) {
    const count = range.end >= range.start ? range.end - range.start + 1 : 0;
    return `${range.start},${count}`;
}
function calculateHunkScore(lines, start, hunk) {
    let score = 0;
    const beforeStart = start - hunk.contextBefore.length;
    for (let i = 0; i < hunk.contextBefore.length; i++) {
        const lineIndex = beforeStart + i;
        if (lineIndex >= 0 && lines[lineIndex] === hunk.contextBefore[i]) {
            score += 2;
        }
    }
    for (let i = 0; i < hunk.removedLines.length; i++) {
        const lineIndex = start + i;
        if (lineIndex >= 0 && lineIndex < lines.length && lines[lineIndex] === hunk.removedLines[i]) {
            score += 4;
        }
    }
    for (let i = 0; i < hunk.contextAfter.length; i++) {
        const lineIndex = start + hunk.removedLines.length + i;
        if (lineIndex >= 0 && lineIndex < lines.length && lines[lineIndex] === hunk.contextAfter[i]) {
            score += 2;
        }
    }
    return score;
}
function canApplyAt(lines, start, hunk) {
    if (start < 0 || start > lines.length) {
        return false;
    }
    const beforeStart = start - hunk.contextBefore.length;
    if (beforeStart < 0) {
        return false;
    }
    for (let i = 0; i < hunk.contextBefore.length; i++) {
        if (lines[beforeStart + i] !== hunk.contextBefore[i]) {
            return false;
        }
    }
    for (let i = 0; i < hunk.removedLines.length; i++) {
        if (lines[start + i] !== hunk.removedLines[i]) {
            return false;
        }
    }
    const afterStart = start + hunk.removedLines.length;
    for (let i = 0; i < hunk.contextAfter.length; i++) {
        if (lines[afterStart + i] !== hunk.contextAfter[i]) {
            return false;
        }
    }
    return true;
}
function applyHunk(lines, hunk) {
    const preferredStart = Math.max(0, hunk.oldRange.start - 1);
    let bestStart = -1;
    let bestScore = -1;
    let bestFuzz = Number.POSITIVE_INFINITY;
    for (let offset = -MAX_FUZZ_OFFSET; offset <= MAX_FUZZ_OFFSET; offset++) {
        const candidate = preferredStart + offset;
        if (!canApplyAt(lines, candidate, hunk)) {
            continue;
        }
        const score = calculateHunkScore(lines, candidate, hunk);
        const fuzz = Math.abs(offset);
        if (score > bestScore || (score === bestScore && fuzz < bestFuzz)) {
            bestScore = score;
            bestStart = candidate;
            bestFuzz = fuzz;
        }
    }
    if (bestStart < 0) {
        throw new Error(`Conflict applying hunk near line ${hunk.oldRange.start}`);
    }
    const next = [...lines];
    next.splice(bestStart, hunk.removedLines.length, ...hunk.addedLines);
    return {
        lines: next,
        matchedAt: bestStart,
        fuzz: bestFuzz,
    };
}
async function verifyPatchedFile(targetPath, content, config) {
    const base = validatePatchContent(targetPath, content, config.syntaxAware);
    if (!base.valid) {
        return base;
    }
    if (targetPath.endsWith('.ts') || targetPath.endsWith('.tsx')) {
        return runTypeScriptSyntaxCheck(content, targetPath);
    }
    return base;
}
async function runTypeScriptSyntaxCheck(content, targetPath) {
    const tempDir = join(process.cwd(), '.jackcode', 'syntax-check');
    await ensureDir(tempDir);
    const tempFile = join(tempDir, `${basename(targetPath).replace(/[^a-zA-Z0-9_.-]/g, '_')}.${randomUUID()}.ts`);
    await fs.writeFile(tempFile, content, 'utf8');
    try {
        const result = await runCommand('tsc', ['--noEmit', '--pretty', 'false', tempFile]);
        return {
            valid: result.code === 0,
            errors: result.code === 0 ? [] : [result.stderr || result.stdout || 'TypeScript syntax check failed'],
        };
    }
    catch {
        return { valid: true, errors: [] };
    }
    finally {
        await fs.rm(tempFile, { force: true });
    }
}
function runCommand(command, args) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            resolve({ code: code ?? 1, stdout, stderr });
        });
    });
}
export function planPatches(changes, config = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const patches = [];
    let totalAdded = 0;
    let totalRemoved = 0;
    const affectedFiles = new Set();
    for (const change of changes) {
        if (!change.targetPath.trim()) {
            throw new Error('Change request targetPath is required');
        }
        const beforeState = {
            exists: false,
            content: '',
            lines: [],
            isBinary: false,
        };
        const afterContent = change.replacement ?? change.insertion ?? '';
        const patch = createPatchFromStates(change, beforeState, afterContent, mergedConfig);
        patches.push(patch);
        affectedFiles.add(change.targetPath);
        for (const hunk of patch.hunks) {
            totalAdded += hunk.addedLines.length;
            totalRemoved += hunk.removedLines.length;
        }
    }
    const plan = {
        id: generateId('plan'),
        createdAt: Date.now(),
        patches,
        impact: {
            filesAffected: affectedFiles.size,
            linesAdded: totalAdded,
            linesRemoved: totalRemoved,
            riskLevel: assessRiskLevel(totalAdded, totalRemoved, affectedFiles.size),
        },
    };
    patchHistory.push({
        id: plan.id,
        timestamp: plan.createdAt,
        action: 'planned',
    });
    return plan;
}
export async function applyPatch(plan, sessionOrOptions, maybeScanner) {
    const applied = [];
    const failed = [];
    const rollbackQueue = [];
    const events = [];
    const options = typeof sessionOrOptions === 'string'
        ? { sessionId: sessionOrOptions, scanner: maybeScanner }
        : (sessionOrOptions ?? {});
    const sortedPatches = [...plan.patches].sort((a, b) => a.targetPath.localeCompare(b.targetPath));
    emitLifecycleEvent(events, 'patch:started', { patchCount: sortedPatches.length }, { planId: plan.id });
    options.runtime?.emit?.('patch:started', { planId: plan.id, patchCount: sortedPatches.length });
    if (options.runtime?.isCancellationRequested?.()) {
        emitLifecycleEvent(events, 'patch:cancelled', { reason: 'runtime cancellation requested' }, { planId: plan.id });
        return {
            success: false,
            applied: [],
            canRollback: false,
            events,
        };
    }
    for (const patch of sortedPatches) {
        const targetPath = normalizePath(patch.targetPath);
        let lockPath;
        try {
            if (options.runtime?.isCancellationRequested?.()) {
                throw Object.assign(new Error('Patch application cancelled'), { failureType: 'io_error', cancelled: true });
            }
            const before = await readFileState(targetPath);
            if (before.isBinary || toMetadata(patch).binary) {
                throw new Error('Binary file patching is not supported');
            }
            const hadChecksumMismatch = before.exists
                && patch.originalChecksum.length > 0
                && computeChecksum(before.content) !== patch.originalChecksum;
            lockPath = await createLock(targetPath);
            let currentLines = [...before.lines];
            let appliedWithFuzz = false;
            for (const hunk of patch.hunks) {
                try {
                    const result = applyHunk(currentLines, hunk);
                    currentLines = result.lines;
                    if (result.fuzz > 0) {
                        appliedWithFuzz = true;
                    }
                }
                catch (error) {
                    throw Object.assign(new Error(error instanceof Error ? error.message : String(error)), { failureType: (hadChecksumMismatch ? 'checksum_mismatch' : 'conflict') });
                }
            }
            if (hadChecksumMismatch && !appliedWithFuzz) {
                throw Object.assign(new Error('Checksum mismatch before apply'), { failureType: 'checksum_mismatch' });
            }
            const nextContent = joinLines(currentLines);
            const verification = await verifyPatchedFile(targetPath, nextContent, { ...DEFAULT_CONFIG, snapshotDir: dirname(patch.reversePatch.storagePath) });
            if (!verification.valid) {
                throw Object.assign(new Error(`Verification failed: ${verification.errors.join('; ')}`), { failureType: 'conflict' });
            }
            const backupPath = before.exists ? await createBackup(targetPath, before.content) : undefined;
            const reversePayload = {
                patchId: patch.id,
                targetPath,
                beforeExists: before.exists,
                afterExists: true,
                beforeContent: before.content,
                afterContent: nextContent,
                beforeMode: before.mode,
                afterMode: before.mode,
                createdAt: Date.now(),
            };
            await storeReversePatch(patch.reversePatch, reversePayload);
            await writeAtomic(targetPath, nextContent, before.mode);
            activeSnapshots.set(patch.id, patch.reversePatch);
            applied.push(patch);
            rollbackQueue.push(patch);
            patchDependencyGraph.set(patch.id, [...(plan.dependencies?.[patch.id] ?? [])]);
            const fragment = makeContextFragment(patch);
            patchContexts.set(patch.id, [fragment]);
            const metadata = toMetadata(patch);
            setMetadata(patch, {
                ...metadata,
                verification,
                impactScore: metadata.impactScore ?? Math.min(100, nextContent.length / 10),
            });
            patchHistory.push({
                id: patch.id,
                timestamp: Date.now(),
                action: 'applied',
                sessionId: options.sessionId,
            });
            emitLifecycleEvent(events, 'patch:applied', { targetPath }, { planId: plan.id, patchId: patch.id });
            options.runtime?.emit?.('patch:applied', { planId: plan.id, patchId: patch.id, targetPath });
            options.session?.addContextFragment?.(options.sessionId ?? '', fragment, options.taskId);
            await options.scanner?.scanIncremental?.([{ path: targetPath, type: 'modified' }]);
            await options.symbolIndex?.updateFile?.(targetPath);
            await options.onPatchApplied?.(patch);
            void backupPath;
        }
        catch (error) {
            if (error.cancelled) {
                emitLifecycleEvent(events, 'patch:cancelled', { patchId: patch.id }, { planId: plan.id, patchId: patch.id });
                return {
                    success: false,
                    applied: [],
                    canRollback: false,
                    events,
                };
            }
            const failureType = (error.failureType ?? classifyFailure(error));
            const failedPatch = {
                patch,
                error: error instanceof Error ? error.message : String(error),
                failureType,
            };
            failed.push(failedPatch);
            emitLifecycleEvent(events, 'patch:failed', { error: failedPatch.error }, { planId: plan.id, patchId: patch.id });
            options.runtime?.emit?.('patch:failed', { planId: plan.id, patchId: patch.id, error: failedPatch.error });
            await options.onPatchFailed?.(failedPatch);
            await rollbackAppliedPatches(rollbackQueue);
            emitLifecycleEvent(events, 'patch:rolled-back', { rolledBack: rollbackQueue.map((item) => item.id), failureType }, { planId: plan.id, patchId: patch.id });
            break;
        }
        finally {
            if (lockPath) {
                await releaseLock(lockPath);
            }
        }
    }
    if (failed.length > 0) {
        return {
            success: false,
            applied: [],
            failed,
            canRollback: false,
            events,
        };
    }
    const verification = await verifyWithBuildAdapters(applied, options);
    if (verification) {
        if (!verification.success) {
            await rollbackAppliedPatches(rollbackQueue);
            if (rollbackQueue.length > 0) {
                emitLifecycleEvent(events, 'patch:rolled-back', { rolledBack: rollbackQueue.map((item) => item.id), verificationFailed: true }, { planId: plan.id });
            }
            options.runtime?.emit?.('patch:verified', { planId: plan.id, success: false, stage: verification.stage });
            return {
                success: false,
                applied: [],
                failed: failed.length > 0 ? failed : undefined,
                canRollback: false,
                verification,
                events,
            };
        }
        emitLifecycleEvent(events, 'patch:verified', { success: true, stage: verification.stage }, { planId: plan.id });
        options.runtime?.emit?.('patch:verified', { planId: plan.id, success: true, stage: verification.stage });
        patchHistory.push({ id: plan.id, timestamp: Date.now(), action: 'verified', sessionId: options.sessionId });
    }
    return {
        success: failed.length === 0,
        applied: failed.length === 0 ? applied : [],
        failed: failed.length > 0 ? failed : undefined,
        canRollback: failed.length === 0 && applied.length > 0,
        verification: verification ?? undefined,
        events,
    };
}
function classifyFailure(error) {
    const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
    if (message.includes('checksum'))
        return 'checksum_mismatch';
    if (message.includes('conflict'))
        return 'conflict';
    if (message.includes('permission'))
        return 'permission_denied';
    return 'io_error';
}
async function rollbackAppliedPatches(patches) {
    for (const patch of [...patches].reverse()) {
        try {
            await rollbackPatch(patch.id);
        }
        catch {
            // Best-effort rollback.
        }
    }
}
export async function rollbackPatch(patchId) {
    const reversePatch = activeSnapshots.get(patchId);
    const rolledBack = [];
    const errors = [];
    if (!reversePatch) {
        return {
            success: false,
            rolledBack,
            errors: [{ patchId, error: 'No snapshot found for patch' }],
        };
    }
    let lockPath;
    try {
        const payload = await loadReversePatch(reversePatch);
        lockPath = await createLock(payload.targetPath);
        if (!payload.beforeExists) {
            await fs.rm(normalizePath(payload.targetPath), { force: true });
        }
        else {
            await writeAtomic(payload.targetPath, payload.beforeContent, payload.beforeMode);
        }
        activeSnapshots.delete(patchId);
        rolledBack.push(patchId);
        patchHistory.push({
            id: patchId,
            timestamp: Date.now(),
            action: 'rolled_back',
        });
    }
    catch (error) {
        errors.push({
            patchId,
            error: error instanceof Error ? error.message : String(error),
        });
    }
    finally {
        if (lockPath) {
            await releaseLock(lockPath);
        }
    }
    return {
        success: errors.length === 0,
        rolledBack,
        errors: errors.length > 0 ? errors : undefined,
    };
}
export function summarizeDiff(patches) {
    const fileSummaries = [];
    let totalInsertions = 0;
    let totalDeletions = 0;
    const changedFiles = new Set();
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
        const metadata = toMetadata(patch);
        const changeType = metadata.changeType
            ?? (fileInsertions > 0 && fileDeletions === 0
                ? 'added'
                : fileInsertions === 0 && fileDeletions > 0
                    ? 'deleted'
                    : 'modified');
        const complexity = metadata.complexity ?? estimateComplexity(fileInsertions, fileDeletions, 0);
        const risk = metadata.riskLevel ? `, risk ${metadata.riskLevel}` : '';
        fileSummaries.push({
            path: patch.targetPath,
            changeType,
            description: `${generateChangeDescription(changeType, fileInsertions, fileDeletions)}${risk}`,
            complexity,
        });
    }
    const stats = {
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
function generateChangeDescription(changeType, insertions, deletions) {
    switch (changeType) {
        case 'added':
            return `Added ${insertions} line${insertions !== 1 ? 's' : ''}`;
        case 'deleted':
            return `Deleted ${deletions} line${deletions !== 1 ? 's' : ''}`;
        case 'modified':
        default:
            return `Modified (${insertions} added, ${deletions} removed)`;
    }
}
function generateOverview(stats) {
    const { filesChanged, insertions, deletions } = stats;
    const fileWord = filesChanged === 1 ? 'file' : 'files';
    if (insertions === 0 && deletions === 0) {
        return `No changes in ${filesChanged} ${fileWord}`;
    }
    const parts = [];
    if (insertions > 0)
        parts.push(`${insertions} insertion${insertions !== 1 ? 's' : ''}`);
    if (deletions > 0)
        parts.push(`${deletions} deletion${deletions !== 1 ? 's' : ''}`);
    return `${filesChanged} ${fileWord} changed, ${parts.join(', ')}`;
}
export function getPatchHistory() {
    return Object.freeze([...patchHistory]);
}
export function canRollback(patchId) {
    return activeSnapshots.has(patchId);
}
export function getActiveSnapshotIds() {
    return Array.from(activeSnapshots.keys());
}
export async function cleanupSnapshots(maxAgeDays) {
    const retentionMs = (maxAgeDays ?? DEFAULT_CONFIG.snapshotRetentionDays) * 24 * 60 * 60 * 1000;
    const cutoff = retentionMs < 0 ? Number.POSITIVE_INFINITY : Date.now() - retentionMs;
    const removed = [];
    for (const [id, snapshot] of activeSnapshots) {
        const historyEntry = patchHistory.find((entry) => entry.id === id);
        if (historyEntry && historyEntry.timestamp <= cutoff) {
            activeSnapshots.delete(id);
            await fs.rm(normalizePath(snapshot.storagePath), { force: true });
            removed.push(id);
        }
    }
    return removed;
}
export function generateUnifiedDiff(patch) {
    const metadata = toMetadata(patch);
    if (metadata.binary) {
        return `Binary files a/${patch.targetPath} and b/${patch.targetPath} differ`;
    }
    const lines = [];
    lines.push(`--- a/${patch.targetPath}`);
    lines.push(`+++ b/${patch.targetPath}`);
    if (metadata.largeFile) {
        lines.push('# diff note: large file, context truncated');
    }
    for (const hunk of patch.hunks) {
        lines.push(`@@ -${formatUnifiedRange(hunk.oldRange)} +${formatUnifiedRange(hunk.newRange)} @@`);
        for (const line of hunk.contextBefore)
            lines.push(` ${line}`);
        for (const line of hunk.removedLines)
            lines.push(`-${line}`);
        for (const line of hunk.addedLines)
            lines.push(`+${line}`);
        for (const line of hunk.contextAfter)
            lines.push(` ${line}`);
    }
    return lines.join('\n');
}
export function generateReversePatch(patch) {
    const reverseHunks = patch.hunks.map((hunk) => ({
        oldRange: hunk.newRange,
        newRange: hunk.oldRange,
        contextBefore: [...hunk.contextBefore],
        removedLines: [...hunk.addedLines],
        addedLines: [...hunk.removedLines],
        contextAfter: [...hunk.contextAfter],
    }));
    const reversePatch = {
        id: `${patch.id}_reverse`,
        targetPath: patch.targetPath,
        hunks: reverseHunks,
        originalChecksum: patch.reversePatch.checksum,
        reversePatch: {
            storagePath: `${patch.reversePatch.storagePath}.reverse`,
            checksum: patch.originalChecksum,
        },
    };
    const metadata = toMetadata(patch);
    setMetadata(reversePatch, {
        ...metadata,
        changeType: metadata.changeType === 'added'
            ? 'deleted'
            : metadata.changeType === 'deleted'
                ? 'added'
                : 'modified',
    });
    return reversePatch;
}
export function validatePatch(patch) {
    const errors = [];
    if (!patch.targetPath.trim()) {
        errors.push('targetPath is required');
    }
    if (patch.hunks.length === 0) {
        errors.push('at least one hunk is required');
    }
    for (const [index, hunk] of patch.hunks.entries()) {
        if (hunk.oldRange.start < 0 || hunk.newRange.start < 0) {
            errors.push(`hunk ${index} has invalid range`);
        }
    }
    const metadata = toMetadata(patch);
    if (metadata.verification && !metadata.verification.valid) {
        errors.push(...metadata.verification.errors);
    }
    return { valid: errors.length === 0, errors };
}
export async function buildPatchFromRequest(request, config = {}) {
    const mergedConfig = { ...DEFAULT_CONFIG, ...config };
    const before = await readFileState(request.targetPath);
    if (before.isBinary) {
        const patch = {
            id: generateId('patch'),
            targetPath: request.targetPath,
            hunks: [],
            originalChecksum: computeChecksum('binary'),
            reversePatch: {
                storagePath: join(mergedConfig.snapshotDir, `${generateId('binary')}.json`),
                checksum: computeChecksum('binary'),
            },
        };
        setMetadata(patch, {
            description: request.description,
            changeType: 'modified',
            complexity: 10,
            riskLevel: 'critical',
            impactScore: 100,
            binary: true,
            largeFile: false,
            verification: { valid: false, errors: ['Binary file detected'] },
        });
        return patch;
    }
    const afterContent = applyChangeRequestToContent(before, request);
    return createPatchFromStates(request, before, afterContent, mergedConfig);
}
export async function verifyWithBuild(patch, build) {
    const verification = await verifyWithBuildAdapters([patch], { build, autoVerify: true });
    return verification ?? { success: true, stage: 'build-test', output: '', errors: [] };
}
export function getContextFragment(patch) {
    return patchContexts.get(patch.id)?.[0] ?? makeContextFragment(patch);
}
export function getPatchDependencies(patchId) {
    return [...(patchDependencyGraph.get(patchId) ?? [])];
}

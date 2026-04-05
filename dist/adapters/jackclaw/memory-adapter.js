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
// ============================================================================
// Memory Adapter Implementation
// ============================================================================
export class JackClawMemoryAdapter {
    config;
    lastSyncTime = 0;
    entryStore = new Map();
    compressor = new ContextCompressor();
    storeLoaded = false;
    constructor(config) {
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
    async pull(query) {
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
    async push(fragments, sessionId) {
        return telemetry.startActiveSpan('jackclaw.memory.push', async (span) => {
            await this.ensureLoaded();
            const result = {
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
                }
                catch (err) {
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
    async sync(sessionId, localFragments) {
        return telemetry.startActiveSpan('jackclaw.memory.sync', async (span) => {
            await this.ensureLoaded();
            const result = {
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
            }
            catch (err) {
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
                }
                catch (err) {
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
    async store(fragment, sessionId) {
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
    async retrieve(query) {
        return this.queryMemory(query);
    }
    /** Update an existing memory entry. */
    async updateEntry(entryId, patch) {
        await this.ensureLoaded();
        const current = this.entryStore.get(entryId);
        if (!current || current.deleted) {
            return null;
        }
        const decoded = this.decodeStoredEntry(current);
        const next = {
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
    async deleteEntry(entryId) {
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
    async getEntry(entryId) {
        await this.ensureLoaded();
        const current = this.entryStore.get(entryId);
        if (!current || current.deleted) {
            return null;
        }
        this.touchStoredEntry(current);
        return this.decodeStoredEntry(current);
    }
    /** Return storage stats useful for testing and telemetry. */
    async getStorageStats() {
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
    async queryMemory(query) {
        await this.ensureLoaded();
        await this.cleanupExpiredEntries();
        const now = Date.now();
        const limit = query.limit && query.limit > 0
            ? Math.min(query.limit, this.config.maxBatchSize)
            : this.config.maxBatchSize;
        const requestedTags = Array.from(new Set(query.tags ?? []));
        const queryText = (query.query ?? '').trim();
        const candidates = [];
        for (const stored of this.entryStore.values()) {
            if (stored.deleted && !query.includeDeleted)
                continue;
            if (!query.includeDeleted && stored.expiresAt !== null && stored.expiresAt <= now)
                continue;
            if (query.sessionId && stored.sessionId !== query.sessionId)
                continue;
            const entry = this.decodeStoredEntry(stored);
            if (query.types?.length && !query.types.includes(entry.type))
                continue;
            if (requestedTags.length > 0 && !requestedTags.every((tag) => entry.metadata.tags.includes(tag)))
                continue;
            const storedTimestamp = entry.timestamp;
            const updatedTimestamp = entry.metadata.updatedAt ?? entry.timestamp;
            const lowerBoundTimestamp = query.query?.trim() || (query.tags?.length ?? 0) > 0
                ? storedTimestamp
                : updatedTimestamp;
            if (typeof query.since === 'number' && lowerBoundTimestamp < query.since)
                continue;
            if (typeof query.until === 'number' && storedTimestamp > query.until)
                continue;
            if (typeof query.minPriority === 'number' && entry.metadata.priority < query.minPriority)
                continue;
            const breakdown = this.scoreEntry(entry, queryText, requestedTags);
            const textFiltered = queryText.length === 0 || breakdown.semantic > 0;
            if (!textFiltered)
                continue;
            candidates.push({
                entry,
                score: breakdown.semantic * 0.45 + breakdown.tags * 0.2 + breakdown.recency * 0.15 + breakdown.priority * 0.2,
                breakdown,
            });
        }
        const sorted = candidates
            .sort((a, b) => {
            const scoreDelta = b.score - a.score;
            if (scoreDelta !== 0)
                return scoreDelta;
            const updatedDelta = (b.entry.metadata.updatedAt ?? b.entry.timestamp) - (a.entry.metadata.updatedAt ?? a.entry.timestamp);
            if (updatedDelta !== 0)
                return updatedDelta;
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
    async writeEntry(entry) {
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
    entryToFragment(entry) {
        const typeMap = {
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
    fragmentToEntry(fragment, sessionId, existingId) {
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
    inferEntryType(fragmentType) {
        const typeMap = {
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
    normalizePriority(priority) {
        if (!Number.isFinite(priority)) {
            return 0;
        }
        return Math.min(1, Math.max(0, priority));
    }
    normalizeEntry(entry) {
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
    async ensureLoaded() {
        if (this.storeLoaded) {
            return;
        }
        const storeFile = this.getStoreFilePath();
        if (existsSync(storeFile)) {
            const raw = JSON.parse(readFileSync(storeFile, 'utf-8'));
            this.entryStore = new Map((raw.entries ?? []).map((entry) => [entry.id, entry]));
        }
        this.storeLoaded = true;
    }
    async persistStore() {
        const storeFile = this.getStoreFilePath();
        mkdirSync(dirname(storeFile), { recursive: true });
        const payload = {
            version: 1,
            updatedAt: Date.now(),
            entries: Array.from(this.entryStore.values()),
        };
        writeFileSync(storeFile, JSON.stringify(payload, null, 2), 'utf-8');
    }
    getStoreFilePath() {
        if (extname(this.config.memoryPath)) {
            return this.config.memoryPath;
        }
        return join(this.config.memoryPath, 'memory-store.json');
    }
    encodeEntry(entry) {
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
        const stored = {
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
    decodeStoredEntry(stored) {
        const parsed = JSON.parse(stored.payload || '{"content":"","metadata":{}}');
        const content = this.restoreContentFromStorage(parsed.content ?? '', Boolean(parsed.metadata?.compressed ?? stored.metadata.compressed), Boolean(parsed.metadata?.encrypted ?? stored.metadata.encrypted));
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
    prepareContentForStorage(entry) {
        let content = entry.content;
        let compressed = false;
        let compressedFromBytes;
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
    restoreContentFromStorage(content, compressed, encrypted) {
        let decoded = content;
        if (encrypted && this.config.encryptionKey) {
            decoded = this.decrypt(decoded, this.config.encryptionKey);
        }
        if (compressed) {
            decoded = gunzipSync(Buffer.from(decoded, 'base64')).toString('utf8');
        }
        return decoded;
    }
    encrypt(content, key) {
        const iv = randomBytes(12);
        const secret = createHash('sha256').update(key).digest();
        const cipher = createCipheriv('aes-256-gcm', secret, iv);
        const encrypted = Buffer.concat([cipher.update(content, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, encrypted]).toString('base64');
    }
    decrypt(content, key) {
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
    scoreEntry(entry, queryText, requestedTags) {
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
    calculateSemanticScore(entry, queryText) {
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
    tokenize(text) {
        return text
            .toLowerCase()
            .replace(/[^a-z0-9_/$.-]+/g, ' ')
            .split(/\s+/)
            .filter((token) => token.length >= 2);
    }
    clamp01(value) {
        return Math.max(0, Math.min(1, value));
    }
    hash(content) {
        return createHash('sha256').update(content).digest('hex');
    }
    findEntryByFragmentId(sessionId, fragmentId) {
        for (const stored of this.entryStore.values()) {
            if (stored.deleted)
                continue;
            if (stored.sessionId !== sessionId)
                continue;
            if (stored.metadata.fragmentId === fragmentId) {
                return this.decodeStoredEntry(stored);
            }
        }
        return null;
    }
    touchStoredEntry(stored) {
        stored.lastAccessedAt = Date.now();
        stored.accessCount += 1;
        stored.metadata.lastAccessedAt = stored.lastAccessedAt;
        stored.metadata.accessCount = stored.accessCount;
        stored.sizeBytes = JSON.stringify(stored).length;
        this.entryStore.set(stored.id, stored);
    }
    async cleanupExpiredEntries() {
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
    async cleanupDeletedEntries() {
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
    async enforceStorageLimits() {
        if (this.entryStore.size <= this.config.maxEntries && this.calculateStorageBytes() <= this.config.storageLimitBytes) {
            return;
        }
        const liveEntries = Array.from(this.entryStore.values())
            .filter((entry) => !entry.deleted)
            .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt || a.timestamp - b.timestamp);
        while ((this.entryStore.size > this.config.maxEntries || this.calculateStorageBytes() > this.config.storageLimitBytes)
            && liveEntries.length > 0) {
            const evicted = liveEntries.shift();
            if (!evicted)
                break;
            this.entryStore.delete(evicted.id);
            telemetryMetrics.incrementCounter('jackcode.memory.evictions', 1, {
                policy: this.config.evictionPolicy,
            });
        }
    }
    calculateStorageBytes() {
        return Array.from(this.entryStore.values()).reduce((sum, entry) => sum + entry.sizeBytes, 0);
    }
    /**
     * Get last sync timestamp
     */
    getLastSyncTime() {
        return this.lastSyncTime;
    }
    /**
     * Get adapter configuration
     */
    getConfig() {
        return { ...this.config };
    }
}
// ============================================================================
// Factory & Helpers
// ============================================================================
/**
 * Create a memory adapter with default configuration
 */
export function createMemoryAdapter(memoryPath) {
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

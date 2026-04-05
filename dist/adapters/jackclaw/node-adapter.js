/**
 * Thread 13: JackClaw Node Adapter
 * Bridges JackCode with JackClaw Node ecosystem
 */
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import process from 'node:process';
import { runtime } from '../../core/runtime.js';
const DEFAULT_CONFIG = {
    autoRegister: true,
    reportCron: '0 8 * * *',
    reconnectIntervalMs: 1_000,
    maxReconnectIntervalMs: 30_000,
    heartbeatIntervalMs: 15_000,
    heartbeatTimeoutMs: 45_000,
    requestTimeoutMs: 10_000,
    rateLimitPerMinute: 120,
    maxConcurrentTasks: 2,
    maxPayloadBytes: 256 * 1024,
};
function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => stableStringify(entry)).join(',')}]`;
    }
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`).join(',')}}`;
}
function sanitizeString(input, maxLength = 4_000) {
    return input.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}
function sanitizeRecord(input, depth = 0) {
    if (!input || typeof input !== 'object' || Array.isArray(input) || depth > 6) {
        return {};
    }
    const output = {};
    for (const [key, value] of Object.entries(input)) {
        if (typeof value === 'string') {
            output[key] = sanitizeString(value, 2_000);
            continue;
        }
        if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
            output[key] = value;
            continue;
        }
        if (Array.isArray(value)) {
            output[key] = value
                .slice(0, 50)
                .flatMap((entry) => {
                if (typeof entry === 'string')
                    return [sanitizeString(entry, 500)];
                if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null)
                    return [entry];
                return [];
            });
            continue;
        }
        if (typeof value === 'object') {
            output[key] = sanitizeRecord(value, depth + 1);
        }
    }
    return output;
}
function sha256(content) {
    return createHash('sha256').update(content).digest('hex');
}
class DefaultRuntimeAdapter {
    createTask(intent, options) {
        return runtime.createTask(intent, options);
    }
    setPlan(id, plan) {
        return runtime.setPlan(id, plan);
    }
    async runTask(id) {
        const result = await runtime.runTask(id);
        return {
            attempts: result.attempts,
            artifacts: result.artifacts,
            errors: result.errors.map((error) => ({ message: error.message })),
        };
    }
}
export class NodeIdentityManager {
    identity;
    constructor(seed) {
        this.identity = this.createIdentity(seed);
    }
    async loadOrCreate(seed) {
        if (seed) {
            this.identity = this.createIdentity({
                ...this.identity,
                nodeId: seed.nodeId ?? this.identity.nodeId,
                sharedSecret: seed.signingSecret ?? this.identity.sharedSecret,
                displayName: seed.displayName ?? this.identity.displayName,
                role: seed.role ?? this.identity.role,
            });
        }
        return { ...this.identity };
    }
    async registerWithHub(hubUrl) {
        if (!hubUrl) {
            throw new Error('Hub URL is required for registration');
        }
    }
    sign(payload, signingSecret) {
        return createHmac('sha256', signingSecret ?? this.identity.sharedSecret).update(stableStringify(payload)).digest('hex');
    }
    verify(senderId, payload, signature, signingSecret) {
        if (!senderId || !signature)
            return false;
        const expected = this.sign(payload, signingSecret);
        return signature === expected;
    }
    createIdentity(seed) {
        const nodeId = seed?.nodeId ?? `node-${randomUUID().replace(/-/g, '').slice(0, 16)}`;
        const secretSource = seed?.sharedSecret ?? randomUUID();
        return {
            nodeId,
            publicKey: seed?.publicKey ?? sha256(`${nodeId}:public:${secretSource}`),
            privateKey: seed?.privateKey ?? sha256(`${nodeId}:private:${secretSource}`),
            sharedSecret: secretSource,
            displayName: seed?.displayName,
            role: seed?.role ?? 'jackcode',
            createdAt: seed?.createdAt ?? Date.now(),
        };
    }
}
export class JackClawNodeAdapter extends EventEmitter {
    config;
    fetchImpl;
    runtimeAdapter;
    now;
    identityManager;
    transport;
    pendingRequests = new Map();
    requestTimestamps = [];
    activeTasks = new Set();
    connected = false;
    authenticated = false;
    reconnectTimer = null;
    heartbeatTimer = null;
    lastHeartbeatAt = 0;
    inflightRequests = 0;
    backoffMs;
    constructor(config, dependencies = {}) {
        super();
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.fetchImpl = dependencies.fetchImpl ?? fetch;
        this.runtimeAdapter = dependencies.runtimeAdapter ?? new DefaultRuntimeAdapter();
        this.now = dependencies.now ?? (() => Date.now());
        this.identityManager = new NodeIdentityManager({ nodeId: this.config.nodeId, displayName: this.config.nodeName, role: 'jackcode-node', sharedSecret: this.config.signingSecret });
        this.transport = dependencies.transportFactory ? dependencies.transportFactory(this.config) : this.createNoopTransport();
        this.backoffMs = this.config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs;
        this.bindTransport();
    }
    get nodeId() {
        return this.getIdentitySync().nodeId;
    }
    get identity() {
        return this.identityManager;
    }
    isConnected() {
        return this.connected;
    }
    isAuthenticated() {
        return this.authenticated;
    }
    async start() {
        await this.transport.connect();
        await this.register();
        this.startHeartbeat();
    }
    async stop() {
        this.stopHeartbeat();
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timeout);
            pending.reject(new Error('Adapter stopped'));
        }
        this.pendingRequests.clear();
        await this.transport.close(1000, 'graceful shutdown');
        this.connected = false;
        this.authenticated = false;
    }
    async register() {
        const identity = this.getIdentitySync();
        const payload = {
            nodeId: identity.nodeId,
            nodeName: this.config.nodeName ?? 'JackCode Node',
            port: this.config.port,
            role: 'jackcode-node',
            publicKey: identity.publicKey,
            capabilities: ['execute', 'review', 'report'],
            loadScore: this.computeLoadScore(),
        };
        await this.sendMessage('auth', payload, { awaitAck: false });
    }
    async handleTask(task) {
        const startedAt = this.now();
        const taskId = sanitizeString(task.taskId || randomUUID(), 128);
        if (this.activeTasks.size >= (this.config.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks)) {
            throw new Error('Max concurrent tasks exceeded');
        }
        this.activeTasks.add(taskId);
        try {
            await this.sendProgress(taskId, {
                taskId,
                state: 'plan',
                message: `Planning task: ${sanitizeString(task.action, 512)}`,
                percentComplete: 10,
                timestamp: this.now(),
            });
            const runtimeTask = this.runtimeAdapter.createTask(task.action, {
                id: taskId,
                priority: task.priority,
                timeoutMs: task.timeoutMs,
            });
            const plan = {
                steps: [
                    {
                        id: `${taskId}-step-1`,
                        description: sanitizeString(task.action, 1_000),
                        targetFiles: [],
                        dependencies: [],
                    },
                ],
                estimatedTokens: 1_000,
                targetModel: 'qwen',
            };
            this.runtimeAdapter.setPlan(runtimeTask.id, plan);
            await this.sendProgress(taskId, {
                taskId,
                state: 'execute',
                message: 'Executing task in JackCode runtime',
                percentComplete: 50,
                timestamp: this.now(),
            });
            const result = await this.runtimeAdapter.runTask(runtimeTask.id);
            const taskResult = {
                taskId,
                status: result.errors.length > 0 ? 'failure' : 'success',
                output: result.errors.length > 0 ? result.errors.map((error) => error.message).join('; ') : 'Task completed successfully',
                artifacts: result.artifacts.map((artifact) => ({
                    type: artifact.type,
                    path: artifact.path,
                    content: artifact.content,
                })),
                error: result.errors.length > 0 ? result.errors[0]?.message : undefined,
                durationMs: this.now() - startedAt,
                attempts: result.attempts,
            };
            await this.sendCompletion(taskId, taskResult);
            return taskResult;
        }
        finally {
            this.activeTasks.delete(taskId);
        }
    }
    async sendProgress(taskId, progress) {
        const message = this.buildSignedMessage('report', {
            type: 'progress',
            taskId,
            progress,
        }, {});
        await this.fetchImpl(this.config.hubUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message),
        });
    }
    async sendCompletion(taskId, result) {
        const message = this.buildSignedMessage('report', {
            type: 'completion',
            taskId,
            result,
        }, {});
        await this.fetchImpl(this.config.hubUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message),
        });
    }
    async sendDailyReport(report) {
        const message = this.buildSignedMessage('report', {
            type: 'daily_report',
            report,
        }, {});
        await this.fetchImpl(this.config.hubUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(message),
        });
    }
    getHealthSnapshot() {
        return {
            nodeId: this.nodeId,
            connected: this.connected,
            authenticated: this.authenticated,
            inflightRequests: this.inflightRequests,
            activeTasks: this.activeTasks.size,
            queuedTasks: 0,
            loadScore: this.computeLoadScore(),
            resourceUsage: this.collectResourceUsage(),
            timestamp: this.now(),
        };
    }
    bindTransport() {
        this.transport.onOpen(() => {
            this.connected = true;
            this.backoffMs = this.config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs;
            this.emit('open');
        });
        this.transport.onClose((code, reason) => {
            this.connected = false;
            this.authenticated = false;
            this.emit('close', code, reason);
            this.scheduleReconnect();
        });
        this.transport.onError((error) => {
            this.emit('error', error);
        });
        this.transport.onMessage((raw) => {
            void this.handleIncoming(raw);
        });
    }
    async handleIncoming(raw) {
        let message;
        try {
            message = JSON.parse(raw);
        }
        catch {
            return;
        }
        if (!this.verifyMessage(message)) {
            this.emit('warning', new Error('Discarded message with invalid signature'));
            return;
        }
        if (message.type === 'broadcast') {
            this.emit('broadcast', message.payload);
        }
        if (message.type === 'auth_ok') {
            this.authenticated = true;
        }
        if (message.type === 'ping') {
            await this.sendMessage('pong', { timestamp: this.now() }, { awaitAck: false, replyTo: message.id });
            return;
        }
        if (message.type === 'health') {
            await this.sendMessage('health_response', this.getHealthSnapshot(), { awaitAck: false, replyTo: message.id });
            return;
        }
        if (message.type === 'task') {
            await this.handleTask(message.payload).catch((error) => {
                this.emit('task_error', error);
                throw error;
            });
        }
        const pendingKey = message.replyTo ?? message.correlationId ?? message.id;
        const pending = this.pendingRequests.get(pendingKey);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(pendingKey);
            pending.resolve(message);
        }
    }
    verifyMessage(message) {
        const { signature, ...unsigned } = message;
        const sharedSecret = this.config.signingSecret;
        return this.identityManager.verify(message.from, unsigned, signature, sharedSecret)
            || this.identityManager.verify(message.from, message.payload, signature, sharedSecret);
    }
    buildSignedMessage(type, payload, options = {}) {
        const identity = this.getIdentitySync();
        const message = {
            id: randomUUID(),
            from: identity.nodeId,
            to: 'hub',
            type,
            payload: sanitizeRecord(payload),
            timestamp: this.now(),
            correlationId: options.correlationId,
            replyTo: options.replyTo,
        };
        return {
            ...message,
            signature: this.identityManager.sign(message),
        };
    }
    async sendMessage(type, payload, options = {}) {
        this.enforceRateLimit();
        const signed = this.buildSignedMessage(type, payload, { correlationId: options.correlationId, replyTo: options.replyTo });
        const raw = JSON.stringify(signed);
        if (Buffer.byteLength(raw, 'utf8') > (this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes)) {
            throw new Error('Payload exceeds configured size limit');
        }
        this.inflightRequests += 1;
        try {
            if (!options.awaitAck) {
                await this.transport.send(raw);
                return;
            }
            return await new Promise(async (resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingRequests.delete(signed.id);
                    reject(new Error(`Request timed out for ${type}`));
                }, this.config.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs);
                this.pendingRequests.set(signed.id, { resolve, reject, timeout });
                try {
                    await this.transport.send(raw);
                }
                catch (error) {
                    clearTimeout(timeout);
                    this.pendingRequests.delete(signed.id);
                    reject(error);
                }
            });
        }
        finally {
            this.inflightRequests = Math.max(0, this.inflightRequests - 1);
        }
    }
    enforceRateLimit() {
        const limit = this.config.rateLimitPerMinute ?? DEFAULT_CONFIG.rateLimitPerMinute;
        const now = this.now();
        while (this.requestTimestamps.length > 0 && now - this.requestTimestamps[0] > 60_000) {
            this.requestTimestamps.shift();
        }
        if (this.requestTimestamps.length >= limit) {
            throw new Error('Rate limit exceeded');
        }
        this.requestTimestamps.push(now);
    }
    scheduleReconnect() {
        if (this.reconnectTimer)
            return;
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.transport.connect().catch((error) => {
                this.emit('error', error);
                this.backoffMs = Math.min(this.backoffMs * 2, this.config.maxReconnectIntervalMs ?? DEFAULT_CONFIG.maxReconnectIntervalMs);
                this.scheduleReconnect();
            });
        }, this.backoffMs);
    }
    startHeartbeat() {
        if (this.heartbeatTimer)
            return;
        this.heartbeatTimer = setInterval(() => {
            const now = this.now();
            if (this.lastHeartbeatAt && now - this.lastHeartbeatAt > (this.config.heartbeatTimeoutMs ?? DEFAULT_CONFIG.heartbeatTimeoutMs)) {
                this.emit('warning', new Error('Heartbeat timeout detected'));
            }
            void this.sendMessage('ping', { timestamp: now }, { awaitAck: false }).catch((error) => this.emit('error', error));
            this.lastHeartbeatAt = now;
        }, this.config.heartbeatIntervalMs ?? DEFAULT_CONFIG.heartbeatIntervalMs);
    }
    stopHeartbeat() {
        if (!this.heartbeatTimer)
            return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
    }
    getIdentitySync() {
        return this.identityManager['identity'];
    }
    async sendRequest(type, payload, options = {}) {
        return this.sendMessage(type, payload, { awaitAck: options.awaitReply });
    }
    async handleRawMessage(raw) {
        if (Buffer.byteLength(raw, 'utf8') > (this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes)) {
            throw new Error('Payload too large');
        }
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch {
            throw new Error('Invalid message payload');
        }
        if (!this.verifyMessage(parsed)) {
            throw new Error('Invalid message signature');
        }
        await this.handleIncoming(raw);
    }
    computeLoadScore() {
        const maxConcurrent = this.config.maxConcurrentTasks ?? DEFAULT_CONFIG.maxConcurrentTasks;
        const inflightWeight = Math.min(1, this.inflightRequests / Math.max(1, maxConcurrent));
        const activeWeight = Math.min(1, this.activeTasks.size / Math.max(1, maxConcurrent));
        return Number(((inflightWeight * 0.4) + (activeWeight * 0.6)).toFixed(2));
    }
    collectResourceUsage() {
        const usage = process.memoryUsage();
        const cpu = process.cpuUsage();
        return {
            memoryRss: usage.rss,
            heapUsed: usage.heapUsed,
            heapTotal: usage.heapTotal,
            uptimeSeconds: process.uptime(),
            cpuUserMicros: cpu.user,
            cpuSystemMicros: cpu.system,
        };
    }
    createNoopTransport() {
        let openHandler;
        let closeHandler;
        let _errorHandler;
        let messageHandler;
        const localNodeId = this.nodeId;
        const sign = (payload) => this.identityManager.sign(payload);
        return {
            onOpen(handler) {
                openHandler = handler;
            },
            onClose(handler) {
                closeHandler = handler;
            },
            onError(handler) {
                _errorHandler = handler;
            },
            onMessage(handler) {
                messageHandler = handler;
            },
            async connect() {
                openHandler?.();
            },
            async send(raw) {
                void raw;
                const ack = {
                    id: randomUUID(),
                    from: 'hub',
                    to: localNodeId,
                    type: 'ack',
                    payload: {},
                    timestamp: Date.now(),
                };
                messageHandler?.(JSON.stringify({
                    ...ack,
                    signature: sign(ack),
                }));
            },
            async close(code, reason) {
                closeHandler?.(code, reason);
            },
        };
    }
}
export class MessageRouter {
    serialize(message) {
        return JSON.stringify(message);
    }
    deserialize(raw) {
        return JSON.parse(raw);
    }
}
export class TaskReceiver {
    identity;
    handlers = [];
    constructor(identity) {
        this.identity = identity;
    }
    start(_port) { }
    onTask(handler) {
        this.handlers.push(handler);
    }
    async handleIncomingTask(message, signingSecret) {
        const { signature, ...unsigned } = message;
        if (!this.identity.verify(message.from, unsigned, signature, signingSecret)
            && !this.identity.verify(message.from, message.payload, signature, signingSecret)) {
            throw new Error('Invalid message signature');
        }
        const payload = sanitizeRecord(message.payload);
        const handler = this.handlers[0];
        if (!handler) {
            throw new Error('No task handler registered');
        }
        return handler(payload);
    }
}
export class TaskRouter {
    runtimeAdapter;
    constructor(runtimeAdapter) {
        this.runtimeAdapter = runtimeAdapter;
    }
    async route(task, onProgress) {
        const startedAt = Date.now();
        const emit = async (state, message, percentComplete) => {
            await onProgress?.({
                taskId: task.taskId,
                state,
                message,
                percentComplete,
                timestamp: Date.now(),
            });
        };
        await emit('plan', `Planning task: ${task.action}`, 10);
        const runtimeTask = this.runtimeAdapter.createTask(task.action, {
            id: task.taskId,
            priority: task.priority,
            timeoutMs: task.timeoutMs,
        });
        this.runtimeAdapter.setPlan(runtimeTask.id, {
            steps: [{ id: `${task.taskId}-step-1`, description: task.action, targetFiles: [], dependencies: [] }],
            estimatedTokens: 1_000,
            targetModel: 'qwen',
        });
        await emit('execute', 'Executing task in JackCode runtime', 50);
        const result = await this.runtimeAdapter.runTask(runtimeTask.id);
        await emit('review', 'Reviewing runtime outputs', 85);
        await emit('done', 'Task completed', 100);
        return {
            taskId: task.taskId,
            status: result.errors.length > 0 ? 'failure' : 'success',
            output: result.errors.length > 0 ? result.errors.map((error) => error.message).join('; ') : 'Task completed successfully',
            artifacts: result.artifacts.map((artifact) => ({ type: artifact.type, path: artifact.path, content: artifact.content })),
            error: result.errors[0]?.message,
            durationMs: Date.now() - startedAt,
            attempts: result.attempts,
        };
    }
}
export class RateLimiter {
    limitPerMinute;
    now;
    timestamps = [];
    constructor(limitPerMinute, now = () => Date.now()) {
        this.limitPerMinute = limitPerMinute;
        this.now = now;
    }
    consume() {
        const current = this.now();
        while (this.timestamps.length > 0 && current - this.timestamps[0] >= 60_000) {
            this.timestamps.shift();
        }
        if (this.timestamps.length >= this.limitPerMinute) {
            return false;
        }
        this.timestamps.push(current);
        return true;
    }
}

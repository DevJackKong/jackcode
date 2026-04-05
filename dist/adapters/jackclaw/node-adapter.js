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
            output[key] = value.slice(0, 50).map((entry) => {
                if (typeof entry === 'string')
                    return sanitizeString(entry, 500);
                if (typeof entry === 'number' || typeof entry === 'boolean' || entry === null)
                    return entry;
                if (typeof entry === 'object')
                    return sanitizeRecord(entry, depth + 1);
                return String(entry);
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
    loadOrCreate() {
        return { ...this.identity };
    }
    async registerWithHub(hubUrl) {
        if (!hubUrl) {
            throw new Error('Hub URL is required for registration');
        }
    }
    sign(payload) {
        return createHmac('sha256', this.identity.sharedSecret).update(stableStringify(payload)).digest('hex');
    }
    verify(senderId, payload, signature) {
        if (!senderId || !signature)
            return false;
        const expected = this.sign(payload);
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
        this.identityManager = new NodeIdentityManager({ nodeId: this.config.nodeId, displayName: this.config.nodeName, role: 'jackcode-node' });
        this.transport = dependencies.transportFactory ? dependencies.transportFactory(this.config) : this.createNoopTransport();
        this.backoffMs = this.config.reconnectIntervalMs ?? DEFAULT_CONFIG.reconnectIntervalMs;
        this.bindTransport();
    }
    get nodeId() {
        return this.identityManager.loadOrCreate().nodeId;
    }
    isConnected() {
        return this.connected;
    }
    isAuthenticated() {
        return this.authenticated;
    }
    async start() {
        await this.transport.connect();
        if (this.config.autoRegister) {
            await this.register();
        }
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
        await this.transport.close(1000, 'shutdown');
        this.connected = false;
        this.authenticated = false;
    }
    async register() {
        const identity = this.identityManager.loadOrCreate();
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
        await this.sendMessage('report', {
            kind: 'progress',
            taskId,
            progress,
        }, { awaitAck: false });
    }
    async sendCompletion(taskId, result) {
        await this.sendMessage('report', {
            kind: 'completion',
            taskId,
            result,
        }, { awaitAck: false });
    }
    async sendDailyReport(report) {
        await this.sendMessage('report', {
            kind: 'daily_report',
            report,
        }, { awaitAck: false });
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
        if (message.type === 'auth_ok') {
            this.authenticated = true;
        }
        if (message.type === 'ping') {
            await this.sendMessage('pong', { timestamp: this.now() }, { awaitAck: false, correlationId: message.id });
            return;
        }
        if (message.type === 'health') {
            await this.sendMessage('health_response', this.getHealthSnapshot(), { awaitAck: false, correlationId: message.id });
            return;
        }
        if (message.type === 'task') {
            void this.handleTask(message.payload).catch((error) => {
                this.emit('task_error', error);
            });
        }
        const pendingKey = message.correlationId ?? message.replyTo ?? message.id;
        const pending = this.pendingRequests.get(pendingKey);
        if (pending) {
            clearTimeout(pending.timeout);
            this.pendingRequests.delete(pendingKey);
            pending.resolve(message);
        }
    }
    verifyMessage(message) {
        const { signature, ...unsigned } = message;
        return this.identityManager.verify(message.from, unsigned, signature);
    }
    async sendMessage(type, payload, options = {}) {
        this.enforceRateLimit();
        const identity = this.identityManager.loadOrCreate();
        const message = {
            id: randomUUID(),
            from: identity.nodeId,
            to: 'hub',
            type,
            payload: sanitizeRecord(payload),
            timestamp: this.now(),
            correlationId: options.correlationId,
        };
        const signed = {
            ...message,
            signature: this.identityManager.sign(message),
        };
        const raw = JSON.stringify(signed);
        if (Buffer.byteLength(raw, 'utf8') > (this.config.maxPayloadBytes ?? DEFAULT_CONFIG.maxPayloadBytes)) {
            throw new Error('Payload exceeds configured size limit');
        }
        this.inflightRequests += 1;
        try {
            await this.transport.send(raw);
            if (!options.awaitAck)
                return;
            return await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    this.pendingRequests.delete(signed.id);
                    reject(new Error(`Request timed out for ${type}`));
                }, this.config.requestTimeoutMs ?? DEFAULT_CONFIG.requestTimeoutMs);
                this.pendingRequests.set(signed.id, { resolve, reject, timeout });
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

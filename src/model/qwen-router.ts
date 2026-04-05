/**
 * Thread 09: Qwen Executor Router
 * Full Qwen executor routing with model selection, retries, batching, caching,
 * fallback handling, and lightweight policy/telemetry integration.
 */

import { createHash } from 'node:crypto';

import { telemetry, telemetryMetrics } from '../core/telemetry.ts';
import type {
  CompletedOperation,
  EscalationReason,
  ExecutionSlot,
  QwenRouteRequest,
  QwenRouteResult,
  RouterConfig,
  RouterMetrics,
  RoutePriority,
} from './types.ts';
import { DEFAULT_ROUTER_CONFIG } from './types.ts';
import type { RoutingDecision } from './types/policy.ts';

export type QwenModelId = 'qwen-3.6' | 'qwen-coder' | 'qwen-3.6-fast';
export type QwenErrorType =
  | 'rate_limit'
  | 'timeout'
  | 'context_overflow'
  | 'tool_error'
  | 'transient'
  | 'fatal';

export interface QwenMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
  toolCallId?: string;
}

export interface QwenToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface QwenToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface QwenPreparedRequest {
  model: QwenModelId;
  messages: QwenMessage[];
  contextWindow: number;
  inputTokens: number;
  maxOutputTokens: number;
  timeoutMs: number;
  stream: boolean;
  tools: QwenToolDefinition[];
  metadata: Record<string, unknown>;
}

export interface QwenProviderResponse {
  content?: string;
  tokensUsed?: number;
  outputTokens?: number;
  toolCalls?: QwenToolCall[];
  finishReason?: string;
  metadata?: Record<string, unknown>;
}

export interface QwenProvider {
  execute(request: QwenPreparedRequest): Promise<QwenProviderResponse>;
  stream?(
    request: QwenPreparedRequest,
    onChunk: (chunk: string) => void
  ): Promise<QwenProviderResponse>;
}

export interface PolicyAdapter {
  selectModel?(task: {
    taskId: string;
    taskType: string;
    files?: string[];
    estimatedTokens?: number;
    failureCount?: number;
    urgency?: 'low' | 'normal' | 'high' | 'critical';
    requiresReasoning?: boolean;
  }): RoutingDecision;
  checkBudget?(cost: number): { allowed: boolean; reason: string };
}

export interface TelemetryAdapter {
  startSpan(name: string, options?: { attributes?: Record<string, unknown> }): SpanLike;
  getMetricsCollector?(): TelemetryMetricsLike;
}

export interface SpanLike {
  setAttribute?(key: string, value: unknown): void;
  addEvent?(name: string, attributes?: Record<string, unknown>): void;
  setStatus?(status: { code: 'unset' | 'ok' | 'error'; message?: string }): void;
  recordException?(error: unknown): void;
}

export interface TelemetryMetricsLike {
  incrementCounter(name: string, value?: number, labels?: Record<string, string>): void;
  recordHistogram(name: string, value: number, labels?: Record<string, string>): void;
  recordGauge(name: string, value: number, labels?: Record<string, string>): void;
}

export interface QwenRouterDependencies {
  provider?: QwenProvider;
  policy?: PolicyAdapter;
  telemetry?: TelemetryAdapter;
}

export interface QwenRouterConfig extends RouterConfig {
  maxContextTokens: number;
  retryLimit: number;
  retryBackoffMs: number;
  cacheTtlMs: number;
  enableCaching: boolean;
  defaultModel: QwenModelId;
  fallbackModel: QwenModelId;
  latencySensitiveThresholdMs: number;
  outputTokenReserve: number;
}

export interface ExtendedQwenRouteRequest extends QwenRouteRequest {
  systemPrompt?: string;
  userPrompt?: string;
  maxOutputTokens?: number;
  stream?: boolean;
  tools?: QwenToolDefinition[];
  metadata?: Record<string, unknown>;
  onStreamChunk?: (chunk: string) => void;
}

interface CacheEntry {
  result: QwenRouteResult;
  expiresAt: number;
}

interface ModelProfile {
  id: QwenModelId;
  contextWindow: number;
  inputCostPer1k: number;
  outputCostPer1k: number;
  averageLatencyMs: number;
  supportsTools: boolean;
  strengths: Array<'coding' | 'general' | 'latency' | 'large-context'>;
}

const DEFAULT_QWEN_ROUTER_CONFIG: QwenRouterConfig = {
  ...DEFAULT_ROUTER_CONFIG,
  maxContextTokens: 128000,
  retryLimit: 2,
  retryBackoffMs: 150,
  cacheTtlMs: 60_000,
  enableCaching: true,
  defaultModel: 'qwen-3.6',
  fallbackModel: 'qwen-3.6-fast',
  latencySensitiveThresholdMs: 2_500,
  outputTokenReserve: 2048,
};

const MODEL_PROFILES: Record<QwenModelId, ModelProfile> = {
  'qwen-3.6': {
    id: 'qwen-3.6',
    contextWindow: 128000,
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.002,
    averageLatencyMs: 2200,
    supportsTools: true,
    strengths: ['general', 'large-context'],
  },
  'qwen-coder': {
    id: 'qwen-coder',
    contextWindow: 64000,
    inputCostPer1k: 0.0015,
    outputCostPer1k: 0.0025,
    averageLatencyMs: 2600,
    supportsTools: true,
    strengths: ['coding'],
  },
  'qwen-3.6-fast': {
    id: 'qwen-3.6-fast',
    contextWindow: 32000,
    inputCostPer1k: 0.0006,
    outputCostPer1k: 0.0012,
    averageLatencyMs: 1200,
    supportsTools: false,
    strengths: ['latency'],
  },
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function createNoopSpan(): SpanLike {
  return {
    setAttribute() {},
    addEvent() {},
    setStatus() {},
    recordException() {},
  };
}

function cloneResult(result: QwenRouteResult): QwenRouteResult {
  return JSON.parse(JSON.stringify(result)) as QwenRouteResult;
}

export class QwenExecutorRouter {
  private readonly config: QwenRouterConfig;
  private readonly provider: QwenProvider;
  private readonly policy?: PolicyAdapter;
  private readonly telemetry: TelemetryAdapter;
  private readonly telemetryMetrics: TelemetryMetricsLike;
  private readonly activeSlots = new Map<string, ExecutionSlot>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly poolLoad = new Map<QwenModelId, number>();
  private readonly requestHistory: number[] = [];
  private slotSequence = 0;
  private metrics: RouterMetrics;

  constructor(
    config: Partial<QwenRouterConfig> = {},
    dependencies: QwenRouterDependencies = {}
  ) {
    this.config = { ...DEFAULT_QWEN_ROUTER_CONFIG, ...config };
    this.provider = dependencies.provider ?? {
      execute: async () => ({ content: 'ok', tokensUsed: 0, outputTokens: 0 }),
    };
    this.policy = dependencies.policy;
    this.telemetry = dependencies.telemetry ?? telemetry;
    this.telemetryMetrics = dependencies.telemetry?.getMetricsCollector?.() ?? telemetryMetrics;
    this.metrics = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      averageLatencyMs: 0,
      currentLoad: 0,
      maxConcurrency: this.config.maxConcurrency,
    };

    for (const model of Object.keys(MODEL_PROFILES) as QwenModelId[]) {
      this.poolLoad.set(model, 0);
    }
  }

  async route(request: QwenRouteRequest): Promise<QwenRouteResult> {
    const normalized = this.normalizeRequest(request);
    const span = this.startSpan('jackcode.qwen.route', {
      task_id: normalized.taskId,
      priority: normalized.priority,
      operation_count: normalized.operations.length,
    });
    const start = Date.now();
    this.metrics.totalRequests += 1;

    try {
      const cacheKey = this.createCacheKey(normalized);
      const cached = this.getCached(cacheKey);
      if (cached) {
        span.addEvent?.('cache_hit');
        this.telemetryMetrics.incrementCounter('jackcode.qwen.cache_hit', 1, { model: 'cache' });
        return cached;
      }

      const slot = await this.acquireSlot(normalized.priority, normalized.timeoutMs);
      try {
        const prepared = this.prepareRequest(normalized);
        const result =
          this.selectStrategy(normalized) === 'batch' && this.config.enableBatching
            ? await this.executeBatch(normalized, prepared, slot, span)
            : await this.executeSingle(normalized, prepared, slot, span);

        this.updateMetrics(result.success, Date.now() - start);
        this.telemetryMetrics.recordHistogram('jackcode.qwen.route_latency_ms', Date.now() - start, {
          model: prepared.model,
        });
        if (this.config.enableCaching && result.success) {
          this.cache.set(cacheKey, {
            result: cloneResult(result),
            expiresAt: Date.now() + this.config.cacheTtlMs,
          });
        }

        span.setStatus?.({ code: 'ok' });
        return result;
      } finally {
        this.releaseSlot(slot);
      }
    } catch (error) {
      this.metrics.failedRequests += 1;
      span.recordException?.(error);
      span.setStatus?.({
        code: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
      return this.createErrorResult(normalized.taskId, error);
    }
  }

  async batchRoute(requests: QwenRouteRequest[]): Promise<QwenRouteResult[]> {
    if (requests.length > this.config.maxBatchSize) {
      throw new Error(`Batch size ${requests.length} exceeds maximum ${this.config.maxBatchSize}`);
    }

    const results = new Array<QwenRouteResult>(requests.length);
    const inflight = new Set<Promise<void>>();

    for (const [index, request] of requests.entries()) {
      let promise!: Promise<void>;
      promise = this.route(request)
        .then((result) => {
          results[index] = result;
        })
        .finally(() => {
          inflight.delete(promise);
        });
      inflight.add(promise);

      if (inflight.size >= this.config.maxConcurrency) {
        await Promise.race(inflight);
      }
    }

    await Promise.all(inflight);
    return results;
  }

  canHandle(context: number | QwenRouteRequest['context']): boolean {
    const tokens = typeof context === 'number' ? context : (context.stats?.finalTokens ?? estimateTokens(context.content));
    return tokens <= this.config.maxContextTokens;
  }

  getMetrics(): RouterMetrics {
    return { ...this.metrics };
  }

  prepareRequest(request: ExtendedQwenRouteRequest): QwenPreparedRequest {
    const contextTokens = request.context.stats?.finalTokens ?? estimateTokens(request.context.content);
    const model = this.selectModel(request, contextTokens);
    const profile = MODEL_PROFILES[model];
    const trimmedContext = this.optimizeContext(request.context.content, profile.contextWindow, request.maxOutputTokens);
    const systemPrompt = request.systemPrompt?.trim() || this.buildSystemPrompt(request);
    const userPrompt = request.userPrompt?.trim() || this.buildUserPrompt(request, trimmedContext);
    const messages: QwenMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ];

    const tools = (request.tools ?? []).filter((tool) => profile.supportsTools || tool.name.length === 0);
    const inputTokens = estimateTokens(`${systemPrompt}\n${userPrompt}`);
    const maxOutputTokens = Math.max(256, request.maxOutputTokens ?? this.config.outputTokenReserve);

    return {
      model,
      messages,
      contextWindow: profile.contextWindow,
      inputTokens,
      maxOutputTokens,
      timeoutMs: request.timeoutMs > 0 ? request.timeoutMs : this.config.defaultTimeoutMs,
      stream: request.stream === true,
      tools: profile.supportsTools ? tools : [],
      metadata: {
        taskId: request.taskId,
        operationCount: request.operations.length,
        contextTokens,
      },
    };
  }

  classifyError(error: unknown): QwenErrorType {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();

    if (normalized.includes('429') || normalized.includes('rate limit') || normalized.includes('too many requests')) {
      return 'rate_limit';
    }
    if (normalized.includes('timeout') || normalized.includes('timed out')) {
      return 'timeout';
    }
    if (normalized.includes('context') || normalized.includes('token') || normalized.includes('maximum length')) {
      return 'context_overflow';
    }
    if (normalized.includes('tool')) {
      return 'tool_error';
    }
    if (normalized.includes('temporary') || normalized.includes('transient') || normalized.includes('unavailable')) {
      return 'transient';
    }
    return 'fatal';
  }

  private normalizeRequest(request: QwenRouteRequest): ExtendedQwenRouteRequest {
    const normalized = request as ExtendedQwenRouteRequest;
    return {
      ...normalized,
      timeoutMs: normalized.timeoutMs > 0 ? normalized.timeoutMs : this.config.defaultTimeoutMs,
      metadata: { ...(normalized.metadata ?? {}) },
    };
  }

  private async acquireSlot(priority: RoutePriority, requestTimeoutMs?: number): Promise<ExecutionSlot> {
    const routerTimeoutMs = priority === 'critical' ? this.config.criticalTimeoutMs : this.config.defaultTimeoutMs;
    const effectiveTimeoutMs = Math.min(requestTimeoutMs ?? routerTimeoutMs, routerTimeoutMs);
    const deadline = Date.now() + effectiveTimeoutMs;

    while (this.activeSlots.size >= this.config.maxConcurrency) {
      if (Date.now() >= deadline) {
        throw new Error('timeout acquiring execution slot');
      }
      await this.sleep(25);
    }

    const acquiredAt = Date.now();
    const slot: ExecutionSlot = {
      id: `slot_${acquiredAt}_${this.slotSequence++}`,
      acquiredAt,
      expiresAt: acquiredAt + effectiveTimeoutMs,
    };

    this.activeSlots.set(slot.id, slot);
    this.metrics.currentLoad = this.activeSlots.size;
    this.telemetryMetrics.recordGauge('jackcode.qwen.current_load', this.metrics.currentLoad, {
      priority,
    });
    return slot;
  }

  private releaseSlot(slot: ExecutionSlot): void {
    this.activeSlots.delete(slot.id);
    this.metrics.currentLoad = this.activeSlots.size;
  }

  private selectStrategy(request: ExtendedQwenRouteRequest): 'single' | 'batch' {
    return request.operations.length > 1 ? 'batch' : 'single';
  }

  private selectModel(request: ExtendedQwenRouteRequest, contextTokens: number): QwenModelId {
    const taskType = this.inferTaskType(request);
    const files = request.operations.map((operation) => operation.targetFile);
    const policyDecision = this.policy?.selectModel?.({
      taskId: request.taskId,
      taskType,
      files,
      estimatedTokens: contextTokens,
      failureCount: Number(request.metadata?.failureCount ?? 0),
      urgency: request.priority === 'critical' ? 'critical' : request.priority,
      requiresReasoning: false,
    });

    if (policyDecision?.selectedModel === 'qwen') {
      if (taskType === 'simple_edit' && contextTokens < 16_000 && !(request.tools?.length)) {
        return 'qwen-3.6-fast';
      }
      if (this.requiresCoderModel(request)) {
        return 'qwen-coder';
      }
      return this.pickByCapability(contextTokens, request);
    }

    if (this.requiresCoderModel(request)) {
      return contextTokens > MODEL_PROFILES['qwen-coder'].contextWindow ? 'qwen-3.6' : 'qwen-coder';
    }

    return this.pickByCapability(contextTokens, request);
  }

  private pickByCapability(contextTokens: number, request: ExtendedQwenRouteRequest): QwenModelId {
    if (request.tools?.length) {
      return contextTokens > MODEL_PROFILES['qwen-coder'].contextWindow ? 'qwen-3.6' : 'qwen-coder';
    }

    if (contextTokens > MODEL_PROFILES['qwen-3.6-fast'].contextWindow) {
      return 'qwen-3.6';
    }

    const cheapCandidate: QwenModelId = request.priority === 'normal' ? 'qwen-3.6-fast' : this.config.defaultModel;
    return this.isCostAllowed(cheapCandidate, contextTokens, request.maxOutputTokens)
      ? cheapCandidate
      : this.config.defaultModel;
  }

  private requiresCoderModel(request: ExtendedQwenRouteRequest): boolean {
    return request.operations.some((operation) => operation.type === 'edit' || operation.type === 'refactor');
  }

  private inferTaskType(request: ExtendedQwenRouteRequest): string {
    if (request.operations.length > 1) return 'batch_operation';
    const type = request.operations[0]?.type;
    if (type === 'refactor') return 'refactor';
    if (type === 'create') return 'simple_edit';
    if (type === 'delete') return 'simple_edit';
    return 'simple_edit';
  }

  private isCostAllowed(model: QwenModelId, inputTokens: number, outputTokens?: number): boolean {
    const estimatedCost = this.estimateCost(model, inputTokens, outputTokens ?? this.config.outputTokenReserve);
    const budget = this.policy?.checkBudget?.(estimatedCost);
    return budget?.allowed ?? true;
  }

  private optimizeContext(context: string, window: number, requestedOutputTokens?: number): string {
    const reserve = Math.max(512, requestedOutputTokens ?? this.config.outputTokenReserve);
    const promptBudget = Math.max(1000, window - reserve - 1024);
    const tokens = estimateTokens(context);
    if (tokens <= promptBudget) {
      return context;
    }

    const keepChars = Math.max(1000, Math.floor(promptBudget * 4));
    const head = context.slice(0, Math.floor(keepChars * 0.65));
    const tail = context.slice(-Math.floor(keepChars * 0.35));
    return `${head}\n\n[... context trimmed for Qwen token budget ...]\n\n${tail}`;
  }

  private buildSystemPrompt(request: ExtendedQwenRouteRequest): string {
    const operationSummary = request.operations
      .map((operation) => `${operation.type}:${operation.targetFile}`)
      .join(', ');
    return `You are Qwen executing code changes for JackCode. Be precise, deterministic, and patch-oriented. Operations: ${operationSummary}. Return implementation-ready output.`;
  }

  private buildUserPrompt(request: ExtendedQwenRouteRequest, optimizedContext: string): string {
    return [
      `Task ID: ${request.taskId}`,
      `Priority: ${request.priority}`,
      'Repository context:',
      optimizedContext,
      'Requested operations:',
      ...request.operations.map(
        (operation) => `- [${operation.type}] ${operation.targetFile}: ${operation.description}`
      ),
    ].join('\n');
  }

  private async executeSingle(
    request: ExtendedQwenRouteRequest,
    prepared: QwenPreparedRequest,
    _slot: ExecutionSlot,
    span: SpanLike
  ): Promise<QwenRouteResult> {
    const startedAt = Date.now();
    const response = await this.executeWithRetry(prepared, request, span);
    const latency = Date.now() - startedAt;

    const operation = request.operations[0];
    const completed: CompletedOperation = {
      ...operation,
      success: true,
      diff: response.content,
      latencyMs: latency,
    };

    return {
      taskId: request.taskId,
      success: true,
      operations: [completed],
      metrics: {
        latencyMs: latency,
        tokensUsed: response.tokensUsed ?? prepared.inputTokens + (response.outputTokens ?? 0),
        cacheHitRatio: this.calculateCacheHitRatio(),
        retryCount: Number(response.metadata?.retryCount ?? 0),
      },
    };
  }

  private async executeBatch(
    request: ExtendedQwenRouteRequest,
    prepared: QwenPreparedRequest,
    _slot: ExecutionSlot,
    span: SpanLike
  ): Promise<QwenRouteResult> {
    const batchSize = Math.min(this.config.maxConcurrency, this.config.maxBatchSize);
    const operations = request.operations;
    const completed: CompletedOperation[] = [];
    let totalLatency = 0;
    let totalTokens = 0;
    let retryCount = 0;

    for (let index = 0; index < operations.length; index += batchSize) {
      const chunk = operations.slice(index, index + batchSize);
      span.addEvent?.('batch_chunk', { size: chunk.length, index });
      const chunkResults = await Promise.all(
        chunk.map(async (operation) => {
          const opRequest: ExtendedQwenRouteRequest = {
            ...request,
            operations: [operation],
            stream: false,
          };
          const opPrepared = this.prepareRequest(opRequest);
          const startedAt = Date.now();
          const response = await this.executeWithRetry(opPrepared, opRequest, span);
          const latencyMs = Date.now() - startedAt;
          totalLatency += latencyMs;
          totalTokens += response.tokensUsed ?? 0;
          retryCount += Number(response.metadata?.retryCount ?? 0);
          return {
            ...operation,
            success: true,
            diff: response.content,
            latencyMs,
          } satisfies CompletedOperation;
        })
      );
      completed.push(...chunkResults);
    }

    return {
      taskId: request.taskId,
      success: completed.every((operation) => operation.success),
      operations: completed,
      metrics: {
        latencyMs: totalLatency,
        tokensUsed: totalTokens || prepared.inputTokens,
        cacheHitRatio: this.calculateCacheHitRatio(),
        retryCount,
      },
    };
  }

  private async executeWithRetry(
    prepared: QwenPreparedRequest,
    request: ExtendedQwenRouteRequest,
    span: SpanLike
  ): Promise<QwenProviderResponse> {
    let lastError: unknown;
    let activeModel = prepared.model;
    let retryCount = 0;

    while (retryCount <= this.config.retryLimit) {
      const currentPrepared =
        activeModel === prepared.model
          ? prepared
          : {
              ...prepared,
              model: activeModel,
              tools: MODEL_PROFILES[activeModel].supportsTools ? prepared.tools : [],
            };
      this.incrementPool(activeModel);
      try {
        const response = await this.invokeProvider(currentPrepared, request);
        response.metadata = { ...(response.metadata ?? {}), retryCount };
        this.telemetryMetrics.incrementCounter('jackcode.qwen.request_success', 1, { model: activeModel });
        return response;
      } catch (error) {
        lastError = error;
        const classification = this.classifyError(error);
        span.addEvent?.('retryable_error', { classification, retryCount, model: activeModel });
        this.telemetryMetrics.incrementCounter('jackcode.qwen.request_error', 1, {
          model: activeModel,
          type: classification,
        });

        if (!this.shouldRetry(classification, retryCount)) {
          break;
        }

        retryCount += 1;
        const failedModel = activeModel;
        if (classification === 'rate_limit' || classification === 'timeout') {
          activeModel = this.selectFallbackModel(activeModel, prepared, request);
        }
        this.decrementPool(failedModel);
        await this.sleep(this.config.retryBackoffMs * retryCount);
        continue;
      } finally {
        this.decrementPool(activeModel);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async invokeProvider(
    prepared: QwenPreparedRequest,
    request: ExtendedQwenRouteRequest
  ): Promise<QwenProviderResponse> {
    if (prepared.stream && typeof this.provider.stream === 'function') {
      let streamed = '';
      const response = await this.provider.stream(prepared, (chunk) => {
        streamed += chunk;
        request.onStreamChunk?.(chunk);
      });
      return {
        ...response,
        content: response.content ?? streamed,
        tokensUsed: response.tokensUsed ?? prepared.inputTokens + estimateTokens(streamed),
      };
    }

    const response = await this.provider.execute(prepared);
    return {
      ...response,
      tokensUsed:
        response.tokensUsed ?? prepared.inputTokens + (response.outputTokens ?? estimateTokens(response.content ?? '')),
    };
  }

  private shouldRetry(type: QwenErrorType, retryCount: number): boolean {
    if (retryCount >= this.config.retryLimit) {
      return false;
    }
    return type === 'rate_limit' || type === 'timeout' || type === 'transient';
  }

  private selectFallbackModel(
    activeModel: QwenModelId,
    prepared: QwenPreparedRequest,
    request: ExtendedQwenRouteRequest
  ): QwenModelId {
    if (this.canHandleWithModel(this.config.fallbackModel, prepared.inputTokens, request.maxOutputTokens)) {
      return this.config.fallbackModel;
    }
    if (activeModel !== 'qwen-3.6' && this.canHandleWithModel('qwen-3.6', prepared.inputTokens, request.maxOutputTokens)) {
      return 'qwen-3.6';
    }
    return activeModel;
  }

  private canHandleWithModel(model: QwenModelId, inputTokens: number, outputTokens?: number): boolean {
    return inputTokens + (outputTokens ?? this.config.outputTokenReserve) <= MODEL_PROFILES[model].contextWindow;
  }

  private createErrorResult(taskId: string, error: unknown): QwenRouteResult {
    const message = error instanceof Error ? error.message : String(error);
    const classification = this.classifyError(error);
    return {
      taskId,
      success: false,
      operations: [],
      metrics: {
        latencyMs: 0,
        tokensUsed: 0,
        cacheHitRatio: this.calculateCacheHitRatio(),
        retryCount: 0,
      },
      escalation: this.toEscalationReason(classification, message),
    };
  }

  private toEscalationReason(type: QwenErrorType, message: string): EscalationReason {
    if (type === 'timeout' || type === 'rate_limit') return 'timeout';
    if (type === 'context_overflow') return 'context_overflow';
    if (message.toLowerCase().includes('syntax') || message.toLowerCase().includes('parse')) return 'syntax_error';
    if (message.toLowerCase().includes('dependency') || message.toLowerCase().includes('import')) return 'dependency_conflict';
    return 'max_retries_exceeded';
  }

  private createCacheKey(request: ExtendedQwenRouteRequest): string {
    const payload = JSON.stringify({
      taskId: request.taskId,
      priority: request.priority,
      context: request.context.content,
      operations: request.operations,
      systemPrompt: request.systemPrompt,
      userPrompt: request.userPrompt,
      tools: request.tools,
      stream: request.stream,
    });
    return createHash('sha1').update(payload).digest('hex');
  }

  private getCached(key: string): QwenRouteResult | null {
    const cached = this.cache.get(key);
    if (!cached) return null;
    if (cached.expiresAt < Date.now()) {
      this.cache.delete(key);
      return null;
    }
    return cloneResult(cached.result);
  }

  private calculateCacheHitRatio(): number {
    return 0;
  }

  private updateMetrics(success: boolean, latencyMs: number): void {
    if (success) this.metrics.successfulRequests += 1;
    else this.metrics.failedRequests += 1;

    this.requestHistory.push(latencyMs);
    if (this.requestHistory.length > 100) {
      this.requestHistory.shift();
    }
    this.metrics.averageLatencyMs =
      this.requestHistory.reduce((sum, value) => sum + value, 0) / this.requestHistory.length;
  }

  private incrementPool(model: QwenModelId): void {
    const next = (this.poolLoad.get(model) ?? 0) + 1;
    this.poolLoad.set(model, next);
    this.telemetryMetrics.recordGauge('jackcode.qwen.pool_load', next, { model });
  }

  private decrementPool(model: QwenModelId): void {
    const next = Math.max(0, (this.poolLoad.get(model) ?? 1) - 1);
    this.poolLoad.set(model, next);
    this.telemetryMetrics.recordGauge('jackcode.qwen.pool_load', next, { model });
  }

  private estimateCost(model: QwenModelId, inputTokens: number, outputTokens: number): number {
    const profile = MODEL_PROFILES[model];
    return (inputTokens / 1000) * profile.inputCostPer1k + (outputTokens / 1000) * profile.outputCostPer1k;
  }

  private startSpan(name: string, attributes: Record<string, unknown>): SpanLike {
    try {
      return this.telemetry.startSpan(name, { attributes }) ?? createNoopSpan();
    } catch {
      return createNoopSpan();
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export const qwenRouter = new QwenExecutorRouter();

export function createQwenRouter(
  config?: Partial<QwenRouterConfig>,
  dependencies?: QwenRouterDependencies
): QwenExecutorRouter {
  return new QwenExecutorRouter(config, dependencies);
}

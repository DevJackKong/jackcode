/**
 * Thread 10: DeepSeek Reasoner Router
 * Full DeepSeek-specific reasoning router with escalation, fallback, and integration helpers.
 */

import type { Artifact, ErrorLog, TaskContext as RuntimeTaskContext } from '../core/runtime.js';
import type { CompressedContext } from '../types/context.js';
import type {
  ModelTier,
  RoutingDecision,
  TaskContext as PolicyTaskContext,
} from './types/policy.js';
import { MODEL_CAPABILITIES, MODEL_PRICING } from './types/policy.js';
import type {
  ConfidenceLevel,
  DeepSeekConfig,
  FailureAnalysis,
  ReasoningHook,
  ReasoningResult,
  RepairContext,
  RepairStrategy,
} from './types/reasoning.js';
import { ModelPolicyEngine } from './policy.js';

export interface DeepSeekMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  name?: string;
}

export interface DeepSeekToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface DeepSeekToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
}

export interface DeepSeekUsage {
  inputTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

export interface DeepSeekTransportRequest {
  model: 'deepseek-chat' | 'deepseek-reasoner';
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  messages: DeepSeekMessage[];
  tools?: DeepSeekToolDefinition[];
  stream?: boolean;
}

export interface DeepSeekTransportResponse {
  content: string;
  reasoning?: string;
  toolCalls?: DeepSeekToolCall[];
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'error';
  usage?: Partial<DeepSeekUsage>;
}

export interface DeepSeekStreamChunk {
  type: 'reasoning' | 'content' | 'tool_call' | 'done';
  delta?: string;
  toolCall?: DeepSeekToolCall;
}

export interface DeepSeekTransport {
  complete(request: DeepSeekTransportRequest): Promise<DeepSeekTransportResponse>;
  stream?(request: DeepSeekTransportRequest): AsyncIterable<DeepSeekStreamChunk>;
}

export type DeepSeekErrorType =
  | 'rate_limit'
  | 'timeout'
  | 'context_overflow'
  | 'auth'
  | 'server'
  | 'network'
  | 'invalid_request'
  | 'unknown';

export interface DeepSeekErrorInfo {
  type: DeepSeekErrorType;
  retryable: boolean;
  message: string;
  retryAfterMs?: number;
}

export interface DeepSeekRouteDecision {
  selectedModel: 'deepseek-chat' | 'deepseek-reasoner';
  useReasoning: boolean;
  budgetedContextTokens: number;
  expectedContextTokens: number;
  estimatedCostUsd: number;
  rationale: string[];
  fallbackModel?: ModelTier;
}

export interface DeepSeekExecutionOptions {
  stream?: boolean;
  tools?: DeepSeekToolDefinition[];
  allowFallback?: boolean;
  signal?: AbortSignal;
}

export interface DeepSeekExecutionResult {
  raw: DeepSeekTransportResponse;
  route: DeepSeekRouteDecision;
  prompt: DeepSeekMessage[];
  reasoningChain: string[];
  toolCalls: DeepSeekToolCall[];
  usage: DeepSeekUsage;
  attempts: number;
  fallbackUsed: boolean;
  error?: DeepSeekErrorInfo;
}

export interface EscalationAssessment {
  shouldEscalate: boolean;
  reason: string;
  trigger:
    | 'build_failed'
    | 'test_failed'
    | 'dependency_error'
    | 'logic_error'
    | 'repeated_failures'
    | 'context_pressure'
    | 'policy_required'
    | 'none';
  severity: 'low' | 'medium' | 'high';
}

export interface DeepSeekRouterOptions {
  transport?: DeepSeekTransport;
  policy?: ModelPolicyEngine;
  maxRetries?: number;
  retryBaseDelayMs?: number;
  maxBackoffMs?: number;
  contextWindowTokens?: {
    chat: number;
    reasoner: number;
  };
  preferredQualityBias?: number;
}

const DEFAULT_CONFIG: DeepSeekConfig = {
  model: 'deepseek-reasoner',
  maxReasoningTokens: 8192,
  temperature: 0.1,
  timeoutMs: 60000,
};

const DEFAULT_OPTIONS: Required<Omit<DeepSeekRouterOptions, 'transport' | 'policy'>> = {
  maxRetries: 3,
  retryBaseDelayMs: 300,
  maxBackoffMs: 4000,
  contextWindowTokens: {
    chat: 64000,
    reasoner: 64000,
  },
  preferredQualityBias: 0.65,
};

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function summarizeArtifacts(artifacts: Artifact[]): string {
  if (artifacts.length === 0) return 'No artifacts.';
  return artifacts
    .slice(0, 8)
    .map((artifact) => `- [${artifact.type}] ${artifact.path}${artifact.content ? `\n${artifact.content.slice(0, 300)}` : ''}`)
    .join('\n');
}

function classifyFailureMessage(message: string): FailureAnalysis['failureType'] {
  const normalized = message.toLowerCase();
  if (normalized.includes('syntax') || normalized.includes('parse') || normalized.includes('unexpected token')) {
    return 'syntax_error';
  }
  if (
    normalized.includes('type') ||
    normalized.includes('typescript') ||
    normalized.includes('not assignable') ||
    normalized.includes('typeerror')
  ) {
    return 'type_error';
  }
  if (normalized.includes('test') || normalized.includes('assert') || normalized.includes('expect')) {
    return 'test_failure';
  }
  if (
    normalized.includes('import') ||
    normalized.includes('module') ||
    normalized.includes('cannot find') ||
    normalized.includes('dependency')
  ) {
    return 'dependency_error';
  }
  if (
    normalized.includes('runtime') ||
    normalized.includes('exception') ||
    normalized.includes('null') ||
    normalized.includes('undefined') ||
    normalized.includes('throw')
  ) {
    return 'runtime_error';
  }
  return 'unknown';
}

export class DeepSeekReasonerRouter {
  private readonly config: DeepSeekConfig;
  private readonly transport?: DeepSeekTransport;
  private readonly policy: ModelPolicyEngine;
  private readonly reasoningHooks: Map<string, ReasoningHook> = new Map();
  private readonly options: Required<Omit<DeepSeekRouterOptions, 'transport' | 'policy'>>;

  constructor(config: Partial<DeepSeekConfig> = {}, options: DeepSeekRouterOptions = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.transport = options.transport;
    this.policy = options.policy ?? new ModelPolicyEngine();
    this.options = {
      maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
      retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_OPTIONS.retryBaseDelayMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_OPTIONS.maxBackoffMs,
      contextWindowTokens: options.contextWindowTokens ?? DEFAULT_OPTIONS.contextWindowTokens,
      preferredQualityBias: options.preferredQualityBias ?? DEFAULT_OPTIONS.preferredQualityBias,
    };
    this.registerDefaultHooks();
  }

  async analyzeFailure(context: RepairContext): Promise<ReasoningResult> {
    const escalation = this.assessEscalation(context);
    const route = this.selectRoute(context);
    const prompt = this.formatPrompt(context, route, escalation);

    let execution: DeepSeekExecutionResult | null = null;
    if (this.transport) {
      execution = await this.executeRequest(prompt, route, { allowFallback: true });
    }

    const analysis = this.performFailureAnalysis(context, execution, escalation);
    const strategy = this.generateRepairStrategy(analysis);
    const confidence = this.scoreConfidence(strategy, escalation, route, execution);
    const reasoningChain = [
      ...analysis.reasoningChain,
      ...((execution?.reasoningChain ?? []).length > 0 ? ['DeepSeek reasoning:', ...execution!.reasoningChain] : []),
    ];

    return {
      rootCause: analysis.rootCause,
      strategy,
      confidence,
      reasoningChain,
      metadata: {
        model: execution?.route.selectedModel ?? route.selectedModel,
        analyzedAt: Date.now(),
        errorCount: context.errors.length,
      },
    };
  }

  assessEscalation(context: RepairContext): EscalationAssessment {
    const lastError = context.errors.at(-1)?.message ?? '';
    const failureType = classifyFailureMessage(lastError);
    const repeatedFailures = context.attemptNumber >= 2 || context.errors.length >= 2;
    const contextTokens = context.context?.stats.finalTokens ?? estimateTokens(context.context?.content ?? '');
    const policyTask = this.createPolicyTaskContext(context);
    const policyDecision = this.policy.selectModel(policyTask);

    if (contextTokens > this.options.contextWindowTokens.reasoner * 0.85) {
      return {
        shouldEscalate: true,
        reason: 'Context pressure suggests dedicated reasoning pass before another execution attempt',
        trigger: 'context_pressure',
        severity: 'medium',
      };
    }

    if (repeatedFailures) {
      return {
        shouldEscalate: true,
        reason: 'Repeated failures indicate cheaper execution path likely missed root cause',
        trigger: 'repeated_failures',
        severity: 'high',
      };
    }

    switch (failureType) {
      case 'test_failure':
        return {
          shouldEscalate: true,
          reason: 'Test failures benefit from explicit reasoning over expectations and implementation drift',
          trigger: 'test_failed',
          severity: 'medium',
        };
      case 'dependency_error':
        return {
          shouldEscalate: true,
          reason: 'Dependency/import failures often require graph-level reasoning',
          trigger: 'dependency_error',
          severity: 'medium',
        };
      case 'runtime_error':
        return {
          shouldEscalate: true,
          reason: 'Runtime/logical failures need causal reasoning beyond executor heuristics',
          trigger: 'logic_error',
          severity: 'high',
        };
      case 'syntax_error':
      case 'type_error':
        return {
          shouldEscalate: context.attemptNumber > 1,
          reason: context.attemptNumber > 1
            ? 'Basic repair already failed; escalate to structured reasoning'
            : 'Single syntax/type failure can usually stay on cheap path first',
          trigger: context.attemptNumber > 1 ? 'build_failed' : 'none',
          severity: context.attemptNumber > 1 ? 'medium' : 'low',
        };
      default:
        return {
          shouldEscalate: repeatedFailures,
          reason: repeatedFailures ? 'Unknown repeated failure merits reasoning escalation' : 'No strong escalation signal',
          trigger: repeatedFailures ? 'repeated_failures' : 'none',
          severity: repeatedFailures ? 'medium' : 'low',
        };
    }
  }

  selectRoute(context: RepairContext): DeepSeekRouteDecision {
    const policyTask = this.createPolicyTaskContext(context);
    const decision = this.policy.selectModel(policyTask);
    const expectedContextTokens = context.context?.stats.finalTokens ?? estimateTokens(context.context?.content ?? context.intent);
    const escalation = this.assessEscalation(context);

    const qualityBias = this.options.preferredQualityBias + (escalation.severity === 'high' ? 0.15 : 0);
    const useReasoning =
      this.config.model === 'deepseek-reasoner' &&
      (policyTask.requiresReasoning || escalation.shouldEscalate || qualityBias >= 0.7);

    const selectedModel: 'deepseek-chat' | 'deepseek-reasoner' = useReasoning ? 'deepseek-reasoner' : 'deepseek-chat';
    const maxContext =
      selectedModel === 'deepseek-reasoner'
        ? this.options.contextWindowTokens.reasoner
        : this.options.contextWindowTokens.chat;
    const budgetedContextTokens = Math.min(expectedContextTokens, Math.floor(maxContext * 0.82));
    const estimatedCostUsd = this.estimateDeepSeekCost(selectedModel, budgetedContextTokens, this.config.maxReasoningTokens);

    const rationale = [
      `Policy selected ${decision.selectedModel}`,
      `Escalation ${escalation.shouldEscalate ? 'enabled' : 'not required'} (${escalation.trigger})`,
      `Reasoning ${useReasoning ? 'enabled' : 'disabled'} for model ${selectedModel}`,
      `Context budget ${budgetedContextTokens}/${maxContext} tokens`,
      `Estimated cost $${estimatedCostUsd.toFixed(4)}`,
    ];

    return {
      selectedModel,
      useReasoning,
      budgetedContextTokens,
      expectedContextTokens,
      estimatedCostUsd,
      rationale,
      fallbackModel: decision.fallbackOnFailure ? 'qwen' : undefined,
    };
  }

  formatPrompt(
    context: RepairContext,
    route: DeepSeekRouteDecision = this.selectRoute(context),
    escalation: EscalationAssessment = this.assessEscalation(context)
  ): DeepSeekMessage[] {
    const contextBody = this.truncateContext(context.context, route.budgetedContextTokens);
    const latestErrors = context.errors
      .slice(-5)
      .map((error, index) => `${index + 1}. [${error.classification}] ${error.message}`)
      .join('\n');

    const system = route.useReasoning
      ? [
          'You are DeepSeek Reasoner inside JackCode.',
          'Analyze the failure, identify root cause, and propose a minimal safe repair plan.',
          'Return sections: ROOT_CAUSE, REASONING, REPAIR_PLAN, RISKS, CONFIDENCE.',
          'Prefer concrete file-level guidance and avoid speculative changes.',
        ].join(' ')
      : [
          'You are DeepSeek Chat inside JackCode.',
          'Summarize failure causes and produce a concise repair strategy.',
          'Return sections: ROOT_CAUSE, REPAIR_PLAN, RISKS, CONFIDENCE.',
        ].join(' ');

    const user = [
      `Task: ${context.intent}`,
      `Task ID: ${context.taskId}`,
      `Attempt: ${context.attemptNumber}/${context.maxAttempts}`,
      `Escalation Trigger: ${escalation.trigger}`,
      `Escalation Reason: ${escalation.reason}`,
      'Recent Errors:',
      latestErrors || 'None',
      'Artifacts:',
      summarizeArtifacts(context.artifacts),
      'Compressed Context:',
      contextBody || '(no compressed context available)',
    ].join('\n\n');

    return [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
  }

  extractReasoningChain(response: Pick<DeepSeekTransportResponse, 'reasoning' | 'content'>): string[] {
    const source = response.reasoning?.trim() || response.content;
    return source
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^[-*\d.\s]+/, '').trim())
      .filter(Boolean);
  }

  async executeRequest(
    prompt: DeepSeekMessage[],
    route: DeepSeekRouteDecision,
    options: DeepSeekExecutionOptions = {}
  ): Promise<DeepSeekExecutionResult> {
    const request: DeepSeekTransportRequest = {
      model: route.selectedModel,
      temperature: route.useReasoning ? this.config.temperature : Math.max(0.15, this.config.temperature),
      maxTokens: this.config.maxReasoningTokens,
      timeoutMs: this.config.timeoutMs,
      messages: prompt,
      tools: options.tools,
      stream: options.stream,
    };

    if (!this.transport) {
      const raw = this.simulateResponse(prompt, route, options.tools);
      return this.finalizeExecutionResult(raw, route, prompt, 1, false);
    }

    let lastError: DeepSeekErrorInfo | undefined;

    for (let attempt = 1; attempt <= this.options.maxRetries; attempt += 1) {
      if (options.signal?.aborted) {
        throw new Error('DeepSeek request aborted');
      }

      try {
        if (options.stream && this.transport.stream) {
          const streamed = await this.consumeStream(this.transport.stream(request));
          return this.finalizeExecutionResult(streamed, route, prompt, attempt, false);
        }

        const raw = await this.transport.complete(request);
        return this.finalizeExecutionResult(raw, route, prompt, attempt, false);
      } catch (error) {
        lastError = this.classifyError(error);
        if (!lastError.retryable || attempt >= this.options.maxRetries) {
          break;
        }
        await sleep(this.computeBackoffDelay(attempt, lastError.retryAfterMs));
      }
    }

    if (options.allowFallback !== false && route.fallbackModel === 'qwen') {
      const raw = this.simulateFallbackResponse(lastError);
      return this.finalizeExecutionResult(raw, route, prompt, this.options.maxRetries, true, lastError);
    }

    return this.finalizeExecutionResult(
      this.simulateFallbackResponse(lastError),
      route,
      prompt,
      this.options.maxRetries,
      false,
      lastError
    );
  }

  createPolicyTaskContext(context: RepairContext): PolicyTaskContext {
    const latest = context.errors.at(-1)?.message ?? '';
    const failureType = classifyFailureMessage(latest);
    const files = this.identifyAffectedFiles(context.errors, context.artifacts);

    return {
      taskId: context.taskId,
      taskType:
        failureType === 'test_failure'
          ? 'test_fix'
          : failureType === 'syntax_error' || failureType === 'type_error'
            ? 'build_fix'
            : 'debug',
      files,
      intent: context.intent,
      estimatedTokens: context.context?.stats.finalTokens ?? estimateTokens(context.context?.content ?? context.intent),
      complexity: context.errors.length + files.length > 4 ? 'high' : undefined,
      requiresReasoning:
        failureType === 'runtime_error' ||
        failureType === 'dependency_error' ||
        failureType === 'test_failure' ||
        context.attemptNumber > 1,
      failureCount: Math.max(context.attemptNumber - 1, 0),
      urgency: context.attemptNumber >= context.maxAttempts ? 'critical' : 'normal',
    };
  }

  createRepairContextFromRuntimeTask(task: RuntimeTaskContext, compressedContext?: CompressedContext): RepairContext {
    return {
      taskId: task.id,
      errors: [...task.errors],
      artifacts: [...task.artifacts],
      context: compressedContext,
      attemptNumber: task.attempts,
      maxAttempts: task.maxAttempts,
      intent: task.intent,
    };
  }

  coordinateWithQwen(
    context: RepairContext,
    qwenDecision?: RoutingDecision
  ): {
    qwenShouldRetry: boolean;
    deepseekShouldAnalyze: boolean;
    integrationNotes: string[];
  } {
    const escalation = this.assessEscalation(context);
    const route = this.selectRoute(context);
    const notes = [
      `Escalation=${escalation.shouldEscalate}`,
      `DeepSeek model=${route.selectedModel}`,
    ];

    if (qwenDecision) {
      notes.push(`Qwen policy decision=${qwenDecision.selectedModel}`);
    }

    const qwenShouldRetry = !escalation.shouldEscalate && context.attemptNumber < context.maxAttempts;
    return {
      qwenShouldRetry,
      deepseekShouldAnalyze: escalation.shouldEscalate || route.useReasoning,
      integrationNotes: notes,
    };
  }

  generateRepairStrategy(analysis: FailureAnalysis): RepairStrategy {
    const primaryTarget = analysis.affectedFiles[0] ?? 'unknown';
    const steps = [
      {
        action: 'inspect_failure_site',
        target: primaryTarget,
        description: 'Confirm the exact failing location and compare expected versus actual behavior.',
        metadata: { failureType: analysis.failureType },
      },
      {
        action: 'apply_minimal_fix',
        target: primaryTarget,
        description: this.describeRepairAction(analysis.failureType),
      },
      {
        action: 'verify_fix',
        target: primaryTarget,
        description: 'Re-run the narrowest relevant build/test command to validate the repair.',
      },
    ];

    if (analysis.failureType === 'dependency_error') {
      steps.splice(1, 0, {
        action: 'verify_dependency_graph',
        target: primaryTarget,
        description: 'Check imports, exports, and symbol names on both sides of the dependency edge.',
      });
    }

    if (analysis.failureType === 'test_failure') {
      steps.splice(1, 0, {
        action: 'map_test_expectations',
        target: 'tests',
        description: 'Extract exact test assertions and preserve intended behavior while fixing implementation drift.',
      });
    }

    const risks = this.assessRisks(analysis);
    const alternatives = this.suggestAlternatives(analysis);
    const estimatedEffort = steps.length >= 5 ? 'high' : steps.length >= 4 ? 'medium' : 'low';

    return {
      plan: {
        steps,
        targetModel: analysis.failureType === 'syntax_error' ? 'qwen' : 'deepseek',
        estimatedTokens: steps.length * 650,
      },
      estimatedEffort,
      risks,
      alternatives,
    };
  }

  scoreConfidence(
    strategy: RepairStrategy,
    escalation?: EscalationAssessment,
    route?: DeepSeekRouteDecision,
    execution?: DeepSeekExecutionResult | null
  ): number {
    let score = 0.48;
    const concreteSteps = strategy.plan.steps.filter((step) => step.target !== 'unknown').length;
    score += concreteSteps * 0.09;
    if (strategy.estimatedEffort === 'low') score += 0.12;
    if (strategy.estimatedEffort === 'high') score -= 0.12;
    if (strategy.risks.includes('breaking_change')) score -= 0.14;
    if (strategy.risks.includes('wide_impact')) score -= 0.08;
    if (escalation?.severity === 'high') score -= 0.06;
    if (route?.useReasoning) score -= 0.04;
    if (execution?.fallbackUsed) score -= 0.18;
    if (execution?.error) score -= execution.error.retryable ? 0.06 : 0.12;
    return clamp(score, 0, 1);
  }

  getConfidenceLevel(score: number): ConfidenceLevel {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  }

  registerHook(name: string, hook: ReasoningHook): void {
    this.reasoningHooks.set(name, hook);
  }

  async executeHook(name: string, context: RepairContext): Promise<ReasoningResult | null> {
    const hook = this.reasoningHooks.get(name);
    return hook ? hook(context) : null;
  }

  classifyError(error: unknown): DeepSeekErrorInfo {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    const retryAfterMatch = normalized.match(/retry[- ]?after[:= ](\d+)/i);
    const retryAfterMs = retryAfterMatch ? Number(retryAfterMatch[1]) : undefined;

    if (normalized.includes('429') || normalized.includes('rate limit')) {
      return { type: 'rate_limit', retryable: true, message, retryAfterMs };
    }
    if (normalized.includes('timeout') || normalized.includes('timed out') || normalized.includes('etimedout')) {
      return { type: 'timeout', retryable: true, message };
    }
    if (normalized.includes('context length') || normalized.includes('too many tokens') || normalized.includes('maximum context')) {
      return { type: 'context_overflow', retryable: false, message };
    }
    if (normalized.includes('401') || normalized.includes('403') || normalized.includes('unauthorized') || normalized.includes('forbidden')) {
      return { type: 'auth', retryable: false, message };
    }
    if (normalized.includes('500') || normalized.includes('502') || normalized.includes('503') || normalized.includes('server error')) {
      return { type: 'server', retryable: true, message };
    }
    if (normalized.includes('network') || normalized.includes('econnreset') || normalized.includes('socket hang up')) {
      return { type: 'network', retryable: true, message };
    }
    if (normalized.includes('400') || normalized.includes('invalid')) {
      return { type: 'invalid_request', retryable: false, message };
    }
    return { type: 'unknown', retryable: false, message };
  }

  private computeBackoffDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.options.maxBackoffMs);
    }
    const exponential = this.options.retryBaseDelayMs * 2 ** (attempt - 1);
    return Math.min(exponential, this.options.maxBackoffMs);
  }

  private truncateContext(context: CompressedContext | undefined, budgetedTokens: number): string {
    const content = context?.content ?? '';
    const maxChars = budgetedTokens * 4;
    if (content.length <= maxChars) {
      return content;
    }
    return `${content.slice(0, Math.max(0, maxChars - 40))}\n...[context truncated for DeepSeek routing]`;
  }

  private performFailureAnalysis(
    context: RepairContext,
    execution: DeepSeekExecutionResult | null,
    escalation: EscalationAssessment
  ): FailureAnalysis {
    const latestError = context.errors.at(-1)?.message ?? 'Unknown failure';
    const failureType = classifyFailureMessage(latestError);
    const affectedFiles = this.identifyAffectedFiles(context.errors, context.artifacts);
    const modelReasoning = execution?.reasoningChain ?? [];

    let rootCause = this.inferRootCause(failureType, context.errors, context.artifacts);
    if (execution?.raw.content) {
      const extracted = this.extractSection(execution.raw.content, 'ROOT_CAUSE');
      if (extracted) rootCause = extracted;
    }

    const reasoningChain = [
      `Failure type classified as ${failureType}`,
      `Escalation: ${escalation.shouldEscalate} (${escalation.trigger})`,
      `Attempt ${context.attemptNumber}/${context.maxAttempts}`,
      `Affected files: ${affectedFiles.join(', ') || 'unknown'}`,
      ...modelReasoning.slice(0, 8),
      `Root cause identified: ${rootCause}`,
    ];

    return {
      failureType,
      rootCause,
      affectedFiles,
      reasoningChain,
      context: {
        errorMessages: context.errors.map((error) => error.message),
        artifactPaths: context.artifacts.map((artifact) => artifact.path),
        compressedContext: context.context?.content ?? '',
      },
    };
  }

  private extractSection(content: string, section: string): string | null {
    const regex = new RegExp(`${section}:?\\s*([\\s\\S]*?)(?:\\n[A-Z_ ]+:|$)`, 'i');
    const match = content.match(regex);
    return match?.[1]?.trim() || null;
  }

  private inferRootCause(
    failureType: FailureAnalysis['failureType'],
    errors: ErrorLog[],
    artifacts: Artifact[]
  ): string {
    const latest = errors.at(-1)?.message ?? 'Unknown failure';
    const artifactHint = artifacts.at(-1)?.path;

    switch (failureType) {
      case 'syntax_error':
        return `Syntax invalidation likely introduced by recent code edit${artifactHint ? ` near ${artifactHint}` : ''}`;
      case 'type_error':
        return `Type contract mismatch or missing annotation inferred from error: ${latest}`;
      case 'test_failure':
        return 'Implementation behavior diverged from asserted test expectations';
      case 'dependency_error':
        return 'Import/export or symbol resolution mismatch across module boundary';
      case 'runtime_error':
        return 'Execution path reached invalid runtime state, suggesting a logic or nullability bug';
      default:
        return `Unable to classify with high confidence; latest failure was: ${latest}`;
    }
  }

  private identifyAffectedFiles(errors: ErrorLog[], artifacts: Artifact[]): string[] {
    const files = new Set<string>();

    for (const error of errors) {
      const match = error.message.match(/([./\w-]+\.(?:ts|tsx|js|jsx|json|mjs|cjs))/i);
      if (match) files.add(match[1]);
    }

    for (const artifact of artifacts) {
      if (artifact.path && !artifact.path.startsWith('runtime/')) {
        files.add(artifact.path);
      }
    }

    return [...files];
  }

  private estimateDeepSeekCost(
    model: 'deepseek-chat' | 'deepseek-reasoner',
    inputTokens: number,
    outputTokens: number
  ): number {
    const pricing = MODEL_PRICING.deepseek;
    const reasoningMultiplier = model === 'deepseek-reasoner' ? 1.25 : 1;
    return (((inputTokens / 1000) * pricing.input) + ((outputTokens / 1000) * pricing.output)) * reasoningMultiplier;
  }

  private assessRisks(analysis: FailureAnalysis): string[] {
    const risks: string[] = [];
    if (analysis.affectedFiles.length >= 3) risks.push('wide_impact');
    if (analysis.failureType === 'test_failure') risks.push('breaking_change');
    if (analysis.failureType === 'dependency_error') risks.push('cascading_failure');
    if (analysis.failureType === 'unknown') risks.push('uncertain_root_cause');
    return risks;
  }

  private suggestAlternatives(analysis: FailureAnalysis): Array<{ description: string; confidence: number }> {
    const alternatives: Array<{ description: string; confidence: number }> = [];
    if (analysis.failureType === 'test_failure') {
      alternatives.push({
        description: 'Reproduce the failing test in isolation before editing implementation.',
        confidence: 0.7,
      });
    }
    if (analysis.failureType === 'type_error') {
      alternatives.push({
        description: 'Use narrower type guards or assertions as a temporary containment fix.',
        confidence: 0.45,
      });
    }
    if (analysis.failureType === 'dependency_error') {
      alternatives.push({
        description: 'Re-export the symbol from the boundary module if direct import path is unstable.',
        confidence: 0.52,
      });
    }
    return alternatives;
  }

  private describeRepairAction(failureType: FailureAnalysis['failureType']): string {
    switch (failureType) {
      case 'syntax_error':
        return 'Correct the syntax while preserving current intent and surrounding structure.';
      case 'type_error':
        return 'Align the implementation with declared types or update the contract consistently.';
      case 'test_failure':
        return 'Change the implementation minimally so behavior matches the tested expectation.';
      case 'dependency_error':
        return 'Repair the import/export chain and resolve symbol naming or module path mismatches.';
      case 'runtime_error':
        return 'Guard the failing code path and restore valid runtime invariants.';
      default:
        return 'Investigate the failure and choose the smallest safe repair.';
    }
  }

  private simulateResponse(
    prompt: DeepSeekMessage[],
    route: DeepSeekRouteDecision,
    tools?: DeepSeekToolDefinition[]
  ): DeepSeekTransportResponse {
    const user = prompt.find((message) => message.role === 'user')?.content ?? '';
    const reasoning = route.useReasoning
      ? [
          'Inspect latest error and classify failure type.',
          'Check whether failure is repeated or context-heavy.',
          'Prefer minimal safe fix with explicit validation step.',
        ].join('\n')
      : undefined;

    return {
      content: [
        'ROOT_CAUSE: Likely localized failure requiring a targeted repair.',
        `REPAIR_PLAN: Inspect the primary failing file, apply the smallest fix, and rerun validation.${tools?.length ? ' Tool support is available if filesystem or test introspection is needed.' : ''}`,
        'RISKS: medium',
        `CONFIDENCE: ${route.useReasoning ? '0.76' : '0.64'}`,
        `CONTEXT_HINT: ${user.slice(0, 120)}`,
      ].join('\n'),
      reasoning,
      toolCalls: tools?.length
        ? [
            {
              id: 'tool-1',
              name: tools[0].name,
              arguments: { objective: 'inspect failure context' },
            },
          ]
        : [],
      finishReason: tools?.length ? 'tool_calls' : 'stop',
    };
  }

  private simulateFallbackResponse(error?: DeepSeekErrorInfo): DeepSeekTransportResponse {
    return {
      content: [
        `ROOT_CAUSE: Fallback analysis activated after DeepSeek request failed${error ? ` due to ${error.type}` : ''}.`,
        'REPAIR_PLAN: Retry the smallest scoped fix path, then escalate to human or higher tier if validation still fails.',
        'RISKS: reduced confidence because model response was unavailable.',
        'CONFIDENCE: 0.42',
      ].join('\n'),
      reasoning: error ? `Fallback activated after ${error.type}: ${error.message}` : 'Fallback activated.',
      finishReason: 'error',
    };
  }

  private async consumeStream(stream: AsyncIterable<DeepSeekStreamChunk>): Promise<DeepSeekTransportResponse> {
    let reasoning = '';
    let content = '';
    const toolCalls: DeepSeekToolCall[] = [];

    for await (const chunk of stream) {
      if (chunk.type === 'reasoning') reasoning += chunk.delta ?? '';
      if (chunk.type === 'content') content += chunk.delta ?? '';
      if (chunk.type === 'tool_call' && chunk.toolCall) toolCalls.push(chunk.toolCall);
    }

    return {
      content,
      reasoning,
      toolCalls,
      finishReason: toolCalls.length > 0 ? 'tool_calls' : 'stop',
    };
  }

  private finalizeExecutionResult(
    raw: DeepSeekTransportResponse,
    route: DeepSeekRouteDecision,
    prompt: DeepSeekMessage[],
    attempts: number,
    fallbackUsed: boolean,
    error?: DeepSeekErrorInfo
  ): DeepSeekExecutionResult {
    const usage = this.normalizeUsage(raw.usage, prompt, raw, route.selectedModel);
    return {
      raw,
      route,
      prompt,
      reasoningChain: this.extractReasoningChain(raw),
      toolCalls: raw.toolCalls ?? [],
      usage,
      attempts,
      fallbackUsed,
      error,
    };
  }

  private normalizeUsage(
    partial: Partial<DeepSeekUsage> | undefined,
    prompt: DeepSeekMessage[],
    raw: DeepSeekTransportResponse,
    model: 'deepseek-chat' | 'deepseek-reasoner'
  ): DeepSeekUsage {
    const promptTokens = prompt.reduce((sum, message) => sum + estimateTokens(message.content), 0);
    const contentTokens = estimateTokens(raw.content);
    const reasoningTokens = raw.reasoning ? estimateTokens(raw.reasoning) : 0;
    const inputTokens = partial?.inputTokens ?? promptTokens;
    const outputTokens = partial?.outputTokens ?? contentTokens;
    const totalReasoningTokens = partial?.reasoningTokens ?? reasoningTokens;
    const totalTokens = partial?.totalTokens ?? inputTokens + outputTokens + totalReasoningTokens;
    const estimatedCostUsd =
      partial?.estimatedCostUsd ?? this.estimateDeepSeekCost(model, inputTokens, outputTokens + totalReasoningTokens);

    return {
      inputTokens,
      outputTokens,
      reasoningTokens: totalReasoningTokens,
      totalTokens,
      estimatedCostUsd,
    };
  }

  private registerDefaultHooks(): void {
    this.registerHook('default', async (context) => this.analyzeFailure(context));
    this.registerHook('quick_fix', async (context) => {
      const escalation = this.assessEscalation(context);
      if (context.errors.length === 1 && !escalation.shouldEscalate) {
        const analysis = this.performFailureAnalysis(context, null, escalation);
        const strategy = this.generateRepairStrategy(analysis);
        const confidence = clamp(this.scoreConfidence(strategy) + 0.12, 0, 0.92);
        return {
          rootCause: analysis.rootCause,
          strategy,
          confidence,
          reasoningChain: [...analysis.reasoningChain, 'Quick-fix hook selected non-escalated path.'],
          metadata: {
            model: 'deepseek-chat',
            analyzedAt: Date.now(),
            errorCount: context.errors.length,
          },
        };
      }
      return null;
    });
  }
}

export const deepseekRouter = new DeepSeekReasonerRouter();

export function createDeepSeekRouter(
  config?: Partial<DeepSeekConfig>,
  options?: DeepSeekRouterOptions
): DeepSeekReasonerRouter {
  return new DeepSeekReasonerRouter(config, options);
}

export default DeepSeekReasonerRouter;

/**
 * Context Compressor
 * Packs and compresses repository/session context for efficient model consumption.
 */

import type {
  ContextFragment,
  PackedContext,
  CompressedContext,
  CompressionStrategy,
  CompressionStats,
  CompressionLevel,
  FragmentType,
  ModelBudget,
  ScoredFragment,
} from '../types/context.js';

import type {
  RepoCompressionConfig,
  RepoCompressedContext,
  RepoMap,
  FileContext,
} from './types.js';

import type { HandoffPayload, Session } from '../types/session.js';
import { RelevanceScorer } from './relevance-scorer.js';
import { telemetry, telemetryMetrics } from '../core/telemetry.js';

export type SupportedModel = 'qwen' | 'deepseek' | 'gpt';

export interface CompressionTelemetry {
  traceId?: string;
  durationMs: number;
  originalTokens: number;
  finalTokens: number;
  level: CompressionLevel;
  model?: SupportedModel;
  query?: string;
  fragmentsIn: number;
  fragmentsOut: number;
}

export interface CompressionBudgetPlan {
  model: SupportedModel;
  maxTokens: number;
  effectiveBudget: number;
  inputBudget: number;
  reservedForPrompt: number;
  reservedForOutput: number;
  safetyMarginTokens: number;
}

export interface CompressionOptions {
  budget?: number;
  level?: CompressionLevel;
  model?: SupportedModel;
  query?: string;
  session?: Pick<Session, 'id' | 'currentTask' | 'taskStack' | 'modelUsage'>;
  handoff?: Pick<HandoffPayload, 'summary' | 'progress' | 'blockers' | 'expectedActions' | 'relevantFiles' | 'toModel'>;
  reservedOutputTokens?: number;
  promptOverheadTokens?: number;
  telemetryLabel?: string;
}

interface CompressionCandidate {
  fragment: ContextFragment;
  relevance: number;
  breakdown: {
    recency: number;
    frequency: number;
    semantic: number;
    priority: number;
    fileImportance: number;
    symbolRelevance: number;
    queryMatch: number;
  };
  preserve: boolean;
  compressed?: ContextFragment;
}

interface BudgetAllocation {
  totalBudget: number;
  perType: Map<FragmentType, number>;
}

const DEFAULT_STRATEGIES: Record<CompressionLevel, CompressionStrategy> = {
  0: {
    level: 0,
    targetBudget: null,
    preserveTypes: ['code', 'doc', 'chat', 'error', 'system', 'file-tree', 'symbol'],
    preserveTags: [],
    minPriority: 0,
  },
  1: {
    level: 1,
    targetBudget: null,
    preserveTypes: ['code', 'error', 'system', 'symbol', 'doc'],
    preserveTags: ['critical', 'error'],
    minPriority: 0.1,
  },
  2: {
    level: 2,
    targetBudget: null,
    preserveTypes: ['code', 'error', 'system', 'symbol'],
    preserveTags: ['critical'],
    minPriority: 0.2,
  },
  3: {
    level: 3,
    targetBudget: null,
    preserveTypes: ['error', 'system', 'symbol', 'code'],
    preserveTags: ['critical'],
    minPriority: 0.35,
  },
};

const MODEL_BUDGETS: Record<SupportedModel, ModelBudget> = {
  qwen: { model: 'qwen', maxTokens: 128000, safetyMargin: 0.1, effectiveBudget: 115200 },
  deepseek: { model: 'deepseek', maxTokens: 64000, safetyMargin: 0.1, effectiveBudget: 57600 },
  gpt: { model: 'gpt', maxTokens: 128000, safetyMargin: 0.15, effectiveBudget: 108800 },
};

const TYPE_ALLOCATION_WEIGHTS: Record<FragmentType, number> = {
  system: 1.2,
  error: 1.1,
  'file-tree': 0.6,
  doc: 0.75,
  symbol: 1,
  code: 1,
  chat: 0.55,
};

const TYPE_OUTPUT_ORDER: Record<FragmentType, number> = {
  system: 0,
  error: 1,
  'file-tree': 2,
  doc: 3,
  symbol: 4,
  code: 5,
  chat: 6,
};

const IMPORTANT_PATH_HINTS = [
  'src/',
  'index.',
  'main.',
  'core/',
  'router',
  'session',
  'context',
  'types.',
  'api/',
];

const LOW_VALUE_PATH_HINTS = ['node_modules/', '.git/', 'dist/', 'coverage/', 'fixtures/', 'testdata/'];

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function getModelBudget(model: SupportedModel): ModelBudget {
  return { ...MODEL_BUDGETS[model] };
}

export function createBudgetPlan(
  model: SupportedModel,
  options: Pick<CompressionOptions, 'budget' | 'reservedOutputTokens' | 'promptOverheadTokens'> = {}
): CompressionBudgetPlan {
  const budget = MODEL_BUDGETS[model];
  const safetyMarginTokens = Math.floor(budget.maxTokens * budget.safetyMargin);
  const reservedForOutput = Math.max(512, options.reservedOutputTokens ?? Math.floor(budget.maxTokens * 0.18));
  const reservedForPrompt = Math.max(256, options.promptOverheadTokens ?? Math.floor(budget.maxTokens * 0.06));
  const effectiveBudget = Math.max(0, budget.maxTokens - safetyMarginTokens);
  const inputBudget = Math.max(
    0,
    Math.min(options.budget ?? effectiveBudget, effectiveBudget - reservedForOutput - reservedForPrompt)
  );

  return {
    model,
    maxTokens: budget.maxTokens,
    effectiveBudget,
    inputBudget,
    reservedForPrompt,
    reservedForOutput,
    safetyMarginTokens,
  };
}

export class ContextCompressor {
  private strategy: CompressionStrategy;
  private relevanceScorer: RelevanceScorer;
  private lastTelemetry: CompressionTelemetry | null = null;

  constructor(strategy: CompressionStrategy = DEFAULT_STRATEGIES[1]) {
    this.strategy = { ...strategy };
    this.relevanceScorer = new RelevanceScorer({
      recency: 0.2,
      frequency: 0.1,
      semantic: 0.35,
      priority: 0.35,
    });
  }

  setStrategy(strategy: CompressionStrategy): void {
    this.strategy = { ...strategy };
  }

  getLastTelemetry(): CompressionTelemetry | null {
    return this.lastTelemetry ? { ...this.lastTelemetry } : null;
  }

  pack(fragments: ContextFragment[]): PackedContext {
    const normalizedFragments = fragments.map((fragment) => ({
      ...fragment,
      tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content),
    }));

    const totalTokens = normalizedFragments.reduce((sum, fragment) => sum + (fragment.tokenCount ?? 0), 0);

    return {
      fragments: normalizedFragments,
      rawTokens: totalTokens,
      packedAt: Date.now(),
    };
  }

  compress(packed: PackedContext, budget?: number): CompressedContext {
    return this.compressWithOptions(packed, { budget });
  }

  compressWithOptions(packed: PackedContext, options: CompressionOptions = {}): CompressedContext {
    return telemetry.startActiveSpan('context.compress', (span) => {
      const startedAt = Date.now();
      const strategy = options.level !== undefined ? DEFAULT_STRATEGIES[options.level] : this.strategy;
      const targetBudget = this.resolveTargetBudget(packed, options, strategy);

      span.setAttributes({
        'context.level': strategy.level,
        'context.raw_tokens': packed.rawTokens,
        'context.target_budget': targetBudget,
        'context.model': options.model,
        'context.query': options.query,
      });

      if (targetBudget === 0) {
        const empty = this.buildCompressed(packed, [], strategy);
        this.captureTelemetry(startedAt, packed, empty, strategy.level, options, span.context.traceId);
        return empty;
      }

      const enrichedQuery = this.buildQuery(options);
      const allocation = this.allocateBudget(packed.fragments, targetBudget);
      const candidates = this.rankCandidates(packed.fragments, enrichedQuery, strategy, options);
      let selected = this.selectWithinBudget(candidates, allocation, targetBudget);

      const selectedTokens = this.calculateTokens(selected);
      if (selectedTokens > targetBudget) {
        selected = this.forceFitBudget(selected, targetBudget, strategy.level);
      }

      const compressed = this.buildCompressed(packed, selected, strategy);
      this.captureTelemetry(startedAt, packed, compressed, strategy.level, options, span.context.traceId);

      span.setAttributes({
        'context.final_tokens': compressed.stats.finalTokens,
        'context.saved_tokens': compressed.stats.savedTokens,
        'context.fragments_out': compressed.fragments.length,
      });

      telemetryMetrics.incrementCounter('jackcode.context.compress.calls', 1, {
        level: String(strategy.level),
        model: options.model ?? 'custom',
      });
      telemetryMetrics.recordHistogram('jackcode.context.compress.saved_tokens', compressed.stats.savedTokens, {
        level: String(strategy.level),
      });

      return compressed;
    }, {
      attributes: {
        'component': options.telemetryLabel ?? 'context-compressor',
      },
    });
  }

  compressForModel(packed: PackedContext, model: SupportedModel): CompressedContext {
    return this.compressWithOptions(packed, { model });
  }

  protected resolveTargetBudget(
    packed: PackedContext,
    options: CompressionOptions,
    strategy: CompressionStrategy
  ): number {
    if (options.model) {
      return createBudgetPlan(options.model, options).inputBudget;
    }

    return Math.max(0, options.budget ?? strategy.targetBudget ?? packed.rawTokens);
  }

  protected buildQuery(options: CompressionOptions): string {
    const parts: string[] = [];

    if (options.query) parts.push(options.query);
    if (options.session?.currentTask?.goal) parts.push(options.session.currentTask.goal);
    if (options.session?.taskStack?.length) {
      parts.push(options.session.taskStack.map((task) => task.goal).join(' '));
    }

    if (options.handoff) {
      parts.push(options.handoff.summary);
      parts.push(options.handoff.progress.join(' '));
      parts.push(options.handoff.blockers.join(' '));
      parts.push(options.handoff.expectedActions.join(' '));
      parts.push(options.handoff.relevantFiles.map((file) => file.path).join(' '));
    }

    return parts.filter(Boolean).join(' ').trim();
  }

  protected rankCandidates(
    fragments: ContextFragment[],
    query: string,
    strategy: CompressionStrategy,
    options: CompressionOptions
  ): CompressionCandidate[] {
    const scored = this.relevanceScorer.score(fragments, query);
    const queryTerms = this.tokenize(query);
    const now = Date.now();

    return scored.map((fragment) => {
      const fileImportance = this.calculateFileImportance(fragment);
      const symbolRelevance = this.calculateSymbolRelevance(fragment, queryTerms);
      const queryMatch = this.calculateQueryMatch(fragment, queryTerms);
      const sessionBoost = this.calculateSessionBoost(fragment, options);
      const preserve = this.shouldPreserve(fragment, strategy);

      const relevance = this.clamp01(
        fragment.relevance * 0.55 +
        fileImportance * 0.15 +
        symbolRelevance * 0.1 +
        queryMatch * 0.1 +
        sessionBoost * 0.1 +
        this.calculateRecencyWeight(fragment, now) * 0.05
      );

      return {
        fragment,
        relevance,
        breakdown: {
          recency: fragment.scoreBreakdown.recency,
          frequency: fragment.scoreBreakdown.frequency,
          semantic: fragment.scoreBreakdown.semantic,
          priority: fragment.scoreBreakdown.priority,
          fileImportance,
          symbolRelevance,
          queryMatch,
        },
        preserve,
      };
    }).sort((a, b) => {
      const preserveDelta = Number(b.preserve) - Number(a.preserve);
      if (preserveDelta !== 0) return preserveDelta;
      const relevanceDelta = b.relevance - a.relevance;
      if (relevanceDelta !== 0) return relevanceDelta;
      return b.fragment.metadata.lastAccess - a.fragment.metadata.lastAccess;
    });
  }

  protected allocateBudget(fragments: ContextFragment[], totalBudget: number): BudgetAllocation {
    const byType = new Map<FragmentType, number>();
    let weightTotal = 0;

    for (const fragment of fragments) {
      const current = byType.get(fragment.type) ?? 0;
      const increment = TYPE_ALLOCATION_WEIGHTS[fragment.type] * Math.max(0.25, fragment.metadata.priority + 0.25);
      byType.set(fragment.type, current + increment);
      weightTotal += increment;
    }

    if (weightTotal === 0) {
      weightTotal = 1;
    }

    const perType = new Map<FragmentType, number>();
    for (const [type, weight] of byType.entries()) {
      const proportional = Math.floor(totalBudget * (weight / weightTotal));
      const minimum = fragments.length <= 4 ? 1 : 24;
      perType.set(type, Math.max(minimum, proportional));
    }

    return { totalBudget, perType };
  }

  protected selectWithinBudget(
    candidates: CompressionCandidate[],
    allocation: BudgetAllocation,
    totalBudget: number
  ): ContextFragment[] {
    const selected: ContextFragment[] = [];
    const spentPerType = new Map<FragmentType, number>();
    let totalSpent = 0;

    for (const candidate of candidates) {
      if (!candidate.preserve && candidate.fragment.metadata.priority < this.strategy.minPriority) {
        continue;
      }

      if (!candidate.preserve && candidate.relevance < Math.max(this.strategy.minPriority, this.strategy.level >= 2 ? 0.35 : 0.18)) {
        continue;
      }

      if (!candidate.preserve && this.strategy.preserveTypes.length > 0 && !this.strategy.preserveTypes.includes(candidate.fragment.type)) {
        continue;
      }

      const perTypeBudget = allocation.perType.get(candidate.fragment.type) ?? totalBudget;
      const perTypeSpent = spentPerType.get(candidate.fragment.type) ?? 0;
      const remainingTotal = totalBudget - totalSpent;

      if (remainingTotal <= 0) break;

      let processed = this.applyCompressionStrategy(candidate, Math.min(perTypeBudget - perTypeSpent, remainingTotal));
      let tokens = processed.tokenCount ?? estimateTokens(processed.content);

      if (tokens <= 0) continue;

      const allowOverflowForPreserved = candidate.preserve && remainingTotal >= Math.min(remainingTotal, 128);
      if (tokens > remainingTotal) {
        processed = this.trimFragmentToBudget(processed, remainingTotal);
        tokens = processed.tokenCount ?? 0;
      }

      if (tokens <= 0) continue;
      if (!allowOverflowForPreserved && perTypeSpent + tokens > perTypeBudget && !candidate.preserve) {
        continue;
      }

      selected.push(processed);
      spentPerType.set(candidate.fragment.type, perTypeSpent + tokens);
      totalSpent += tokens;
    }

    if (selected.length === 0 && candidates.length > 0) {
      selected.push(this.trimFragmentToBudget(this.applyCompressionStrategy(candidates[0], totalBudget), totalBudget));
    }

    return selected.filter((fragment) => (fragment.tokenCount ?? 0) > 0);
  }

  protected applyCompressionStrategy(candidate: CompressionCandidate, availableBudget: number): ContextFragment {
    const fragment = candidate.fragment;
    const currentTokens = fragment.tokenCount ?? estimateTokens(fragment.content);

    if (this.strategy.level === 0 && currentTokens <= availableBudget) {
      return { ...fragment, tokenCount: currentTokens };
    }

    let processed = { ...fragment, tokenCount: currentTokens };

    if (this.strategy.level >= 1) {
      processed = this.semanticDeduplicate(processed);
    }

    if (this.strategy.level >= 1 && processed.type === 'chat') {
      processed = this.summarizeFragment(processed, 8);
    }

    if (this.strategy.level >= 1 && (processed.type === 'code' || processed.type === 'doc')) {
      processed = this.smartFilterFragment(processed, this.strategy.level);
    }

    if (this.strategy.level >= 2 && processed.type !== 'system' && processed.type !== 'error') {
      processed = this.summarizeFragment(processed, processed.type === 'code' ? 12 : 10);
    }

    if (this.strategy.level >= 3) {
      processed = this.elideFragment(processed);
    }

    const processedTokens = processed.tokenCount ?? estimateTokens(processed.content);
    if (processedTokens > availableBudget) {
      return this.trimFragmentToBudget(processed, availableBudget);
    }

    return processed;
  }

  protected semanticDeduplicate(fragment: ContextFragment): ContextFragment {
    const seen = new Set<string>();
    const lines: string[] = [];

    for (const rawLine of fragment.content.split(/\r?\n/)) {
      const line = rawLine.trimEnd();
      const signature = this.normalizeSemanticUnit(line);
      if (!signature) {
        lines.push(rawLine);
        continue;
      }
      if (seen.has(signature)) {
        continue;
      }
      seen.add(signature);
      lines.push(rawLine);
    }

    const content = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (content === fragment.content.trim()) {
      return { ...fragment, tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content) };
    }

    return this.withTag(fragment, content, 'semantic-compressed');
  }

  protected smartFilterFragment(fragment: ContextFragment, level: CompressionLevel): ContextFragment {
    if (fragment.type !== 'code') {
      const content = this.compressPlainText(fragment.content, level);
      return content === fragment.content.trim()
        ? { ...fragment, tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content) }
        : this.withTag(fragment, content, 'filtered');
    }

    const lines = fragment.content.split(/\r?\n/);
    const kept: string[] = [];
    let braceDepth = 0;
    let skippingBody = false;

    for (const line of lines) {
      const trimmed = line.trim();
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;

      const isComment = /^\s*(\/\/|\/\*|\*)/.test(line);
      const isDeclaration = /^(export\s+)?(interface|type|enum)\b/.test(trimmed);
      const isSignature = /^(export\s+)?(async\s+)?function\b/.test(trimmed)
        || /^(export\s+)?const\s+[A-Za-z0-9_$]+\s*=\s*(async\s*)?\(/.test(trimmed)
        || /^(public|private|protected|static|async|get|set)\s+/.test(trimmed)
        || /^[A-Za-z0-9_$]+\s*\([^)]*\)\s*[:{]/.test(trimmed)
        || /^class\s+/.test(trimmed)
        || /^export\s+class\s+/.test(trimmed)
        || /^constructor\s*\(/.test(trimmed);
      const importantStatement = /^\s*import\s+/.test(line) || /^\s*export\s+\{/.test(line);

      if (isComment) {
        if (this.keepComment(line, level)) {
          kept.push(line);
        }
      } else if (importantStatement || isDeclaration) {
        kept.push(line);
      } else if (isSignature) {
        if (trimmed.endsWith('{')) {
          kept.push(line.replace(/\{\s*$/, '{ /* implementation elided */ }'));
          skippingBody = true;
        } else {
          kept.push(line);
        }
      } else if (!skippingBody && braceDepth === 0 && trimmed.length > 0 && /=>|return\s+|throw\s+/.test(trimmed) && level <= 1) {
        kept.push(line);
      }

      braceDepth += opens - closes;
      if (skippingBody && braceDepth <= 0) {
        skippingBody = false;
        braceDepth = 0;
      }
    }

    const content = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (!content) {
      return this.summarizeFragment(fragment, 8);
    }

    return this.withTag(fragment, content, 'filtered');
  }

  protected summarizeFragment(fragment: ContextFragment, maxLines = 10): ContextFragment {
    const summary = this.generateSummary(fragment, maxLines);
    if (!summary || summary.trim() === fragment.content.trim()) {
      return { ...fragment, tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content) };
    }

    return this.withTag(fragment, summary, 'summarized');
  }

  protected elideFragment(fragment: ContextFragment): ContextFragment {
    const lines = fragment.content.split(/\r?\n/);
    if (lines.length <= 6) {
      return { ...fragment, tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content) };
    }

    const head = lines.slice(0, 3);
    const tail = lines.slice(-2);
    const content = [...head, '// ... elided ...', ...tail].join('\n');
    return this.withTag(fragment, content, 'elided');
  }

  protected forceFitBudget(fragments: ContextFragment[], budget: number, level: CompressionLevel): ContextFragment[] {
    const sorted = [...fragments].sort((a, b) => {
      const priorityDelta = b.metadata.priority - a.metadata.priority;
      if (priorityDelta !== 0) return priorityDelta;
      return TYPE_OUTPUT_ORDER[a.type] - TYPE_OUTPUT_ORDER[b.type];
    });

    const fitted: ContextFragment[] = [];
    let spent = 0;

    for (const fragment of sorted) {
      const remaining = budget - spent;
      if (remaining <= 0) break;
      const tokens = fragment.tokenCount ?? estimateTokens(fragment.content);
      if (spent + tokens <= budget) {
        fitted.push(fragment);
        spent += tokens;
        continue;
      }

      const trimmed = this.trimFragmentToBudget(level >= 2 ? this.elideFragment(fragment) : fragment, remaining);
      if ((trimmed.tokenCount ?? 0) > 0) {
        fitted.push(trimmed);
        spent += trimmed.tokenCount ?? 0;
      }
    }

    return fitted;
  }

  protected shouldPreserve(fragment: ScoredFragment, strategy: CompressionStrategy): boolean {
    return strategy.preserveTypes.includes(fragment.type)
      || fragment.metadata.tags.some((tag) => strategy.preserveTags.includes(tag))
      || fragment.metadata.tags.includes('critical')
      || fragment.type === 'system'
      || fragment.type === 'error';
  }

  protected calculateFileImportance(fragment: ContextFragment): number {
    let score = fragment.type === 'code' ? 0.45 : fragment.type === 'symbol' ? 0.55 : 0.35;
    const path = (('relativePath' in fragment ? fragment.relativePath : fragment.source) ?? '').toLowerCase();

    for (const hint of IMPORTANT_PATH_HINTS) {
      if (path.includes(hint)) score += 0.08;
    }
    for (const hint of LOW_VALUE_PATH_HINTS) {
      if (path.includes(hint)) score -= 0.2;
    }

    if ('definedSymbols' in fragment) {
      score += Math.min(0.2, fragment.definedSymbols.length * 0.03);
      if (fragment.language === 'typescript' || fragment.language === 'tsx') {
        score += 0.08;
      }
    }

    if (fragment.metadata.tags.includes('entrypoint')) score += 0.15;
    if (fragment.metadata.tags.includes('critical')) score += 0.2;

    return this.clamp01(score);
  }

  protected calculateSymbolRelevance(fragment: ContextFragment, queryTerms: string[]): number {
    if (!(('definedSymbols' in fragment) || fragment.type === 'symbol')) {
      return 0.3;
    }

    const symbols = new Set<string>();
    if ('definedSymbols' in fragment) {
      for (const symbol of fragment.definedSymbols) symbols.add(symbol.toLowerCase());
      for (const symbol of fragment.referencedSymbols) symbols.add(symbol.toLowerCase());
    } else {
      for (const token of this.tokenize(fragment.content)) symbols.add(token);
    }

    if (symbols.size === 0) return 0.3;
    if (queryTerms.length === 0) return Math.min(1, 0.35 + symbols.size * 0.03);

    let matches = 0;
    for (const term of queryTerms) {
      for (const symbol of symbols) {
        if (symbol.includes(term) || term.includes(symbol)) {
          matches++;
          break;
        }
      }
    }

    return this.clamp01(matches / Math.max(1, queryTerms.length));
  }

  protected calculateRecencyWeight(fragment: ContextFragment, now: number): number {
    const timestamps = [fragment.timestamp, fragment.metadata.lastAccess];
    if ('modifiedAt' in fragment) timestamps.push(fragment.modifiedAt);
    const freshest = Math.max(...timestamps.filter((value) => Number.isFinite(value)));
    const ageHours = Math.max(0, (now - freshest) / (1000 * 60 * 60));
    return Math.exp(-ageHours / 24);
  }

  protected calculateQueryMatch(fragment: ContextFragment, queryTerms: string[]): number {
    if (queryTerms.length === 0) return 0.5;

    const haystack = [fragment.content, fragment.source ?? ''];
    if ('relativePath' in fragment) haystack.push(fragment.relativePath);
    if ('definedSymbols' in fragment) haystack.push(fragment.definedSymbols.join(' '));
    const text = haystack.join(' ').toLowerCase();

    let matches = 0;
    for (const term of queryTerms) {
      if (text.includes(term)) matches++;
    }

    return matches / queryTerms.length;
  }

  protected calculateSessionBoost(fragment: ContextFragment, options: CompressionOptions): number {
    let boost = 0;
    const goals = options.session?.taskStack?.map((task) => task.goal.toLowerCase()) ?? [];
    const currentGoal = options.session?.currentTask?.goal.toLowerCase();
    const source = `${fragment.source ?? ''} ${'relativePath' in fragment ? fragment.relativePath : ''}`.toLowerCase();

    if (currentGoal && source.includes(this.tokenize(currentGoal)[0] ?? '')) {
      boost += 0.25;
    }

    if (options.handoff?.relevantFiles.some((file) => source.includes(file.path.toLowerCase()))) {
      boost += 0.35;
    }

    if (goals.length > 0) {
      const goalTokens = this.tokenize(goals.join(' '));
      boost += this.calculateQueryMatch(fragment, goalTokens) * 0.2;
    }

    return this.clamp01(boost);
  }

  protected generateSummary(fragment: ContextFragment, maxLines: number): string {
    const lines = fragment.content.split(/\r?\n/);
    const comments = lines.filter((line) => this.keepComment(line, 1)).slice(0, 3);
    const signatures = lines.filter((line) => this.looksLikeSignature(line.trim())).slice(0, maxLines);
    const importantPlain = lines
      .map((line) => line.trim())
      .filter((line) => line && line.length > 12 && !this.looksLikeNoise(line))
      .slice(0, Math.max(2, maxLines - signatures.length - comments.length));

    const chunks: string[] = [];
    const title = fragment.source ? `${fragment.type}:${fragment.source}` : fragment.type;
    chunks.push(`Summary of ${title}`);

    if (comments.length > 0) {
      chunks.push(...comments.map((line) => line.trim()));
    }

    if (signatures.length > 0) {
      chunks.push('Key signatures:');
      chunks.push(...signatures.map((line) => `- ${line.trim()}`));
    } else if (importantPlain.length > 0) {
      chunks.push('Key points:');
      chunks.push(...importantPlain.map((line) => `- ${line}`));
    }

    return chunks.join('\n').trim();
  }

  protected compressPlainText(content: string, level: CompressionLevel): string {
    const lines = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line, index, list) => index === 0 || line !== list[index - 1]);

    const maxLines = level <= 1 ? 18 : level === 2 ? 10 : 6;
    return lines.slice(0, maxLines).join('\n').trim();
  }

  protected keepComment(line: string, level: CompressionLevel): boolean {
    const normalized = line.trim();
    if (!normalized) return false;
    if (/TODO|FIXME|NOTE|IMPORTANT|HACK/i.test(normalized)) return true;
    if (level <= 1 && normalized.startsWith('//')) return normalized.length > 8;
    return /@param|@returns|@throws|@deprecated/i.test(normalized);
  }

  protected looksLikeSignature(line: string): boolean {
    return /^(export\s+)?(async\s+)?function\b/.test(line)
      || /^(export\s+)?class\b/.test(line)
      || /^(export\s+)?interface\b/.test(line)
      || /^(export\s+)?type\b/.test(line)
      || /^\w+\s*\([^)]*\)\s*[:{]/.test(line)
      || /^const\s+\w+\s*=\s*(async\s*)?\(/.test(line);
  }

  protected looksLikeNoise(line: string): boolean {
    return line.length < 4 || /^[{}()[\],;]+$/.test(line);
  }

  protected trimFragmentToBudget(fragment: ContextFragment, budget: number): ContextFragment {
    if (budget <= 0) {
      return { ...fragment, content: '', tokenCount: 0 };
    }

    const maxChars = Math.max(1, budget * 4);
    const suffix = '\n// ... truncated';
    if (fragment.content.length <= maxChars) {
      return { ...fragment, tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content) };
    }

    const trimmedContent = `${fragment.content.slice(0, Math.max(1, maxChars - suffix.length))}${suffix}`;
    return this.withTag(fragment, trimmedContent, 'truncated');
  }

  protected calculateTokens(fragments: ContextFragment[]): number {
    return fragments.reduce((sum, fragment) => sum + (fragment.tokenCount ?? estimateTokens(fragment.content)), 0);
  }

  protected buildCompressed(
    original: PackedContext,
    fragments: ContextFragment[],
    strategy: CompressionStrategy
  ): CompressedContext {
    const sortedFragments = this.sortForOutput(fragments);
    const finalTokens = this.calculateTokens(sortedFragments);
    const originalTokens = original.rawTokens;
    const content = this.formatContent(sortedFragments);

    const stats: CompressionStats = {
      originalTokens,
      finalTokens,
      savedTokens: Math.max(0, originalTokens - finalTokens),
      ratio: originalTokens > 0 ? finalTokens / originalTokens : 0,
      fragmentsDropped: Math.max(0, original.fragments.length - sortedFragments.length),
      fragmentsSummarized: sortedFragments.filter((fragment) =>
        fragment.metadata.tags.some((tag) => ['summarized', 'truncated', 'filtered', 'elided', 'semantic-compressed'].includes(tag))
      ).length,
    };

    return {
      content,
      fragments: sortedFragments,
      stats,
      strategy: { ...strategy },
      compressedAt: Date.now(),
    };
  }

  protected sortForOutput(fragments: ContextFragment[]): ContextFragment[] {
    return [...fragments].sort((a, b) => {
      const typeDiff = TYPE_OUTPUT_ORDER[a.type] - TYPE_OUTPUT_ORDER[b.type];
      if (typeDiff !== 0) return typeDiff;
      const priorityDiff = b.metadata.priority - a.metadata.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return b.metadata.lastAccess - a.metadata.lastAccess;
    });
  }

  protected formatContent(fragments: ContextFragment[]): string {
    return fragments
      .map((fragment) => {
        const header = fragment.source ? `[${fragment.type}] ${fragment.source}` : `[${fragment.type}]`;
        const tags = fragment.metadata.tags.length > 0 ? ` tags=${fragment.metadata.tags.join(',')}` : '';
        return `${header}${tags}\n${fragment.content}`;
      })
      .join('\n\n---\n\n');
  }

  protected withTag(fragment: ContextFragment, content: string, tag: string): ContextFragment {
    return {
      ...fragment,
      content,
      tokenCount: estimateTokens(content),
      metadata: {
        ...fragment.metadata,
        tags: Array.from(new Set([...fragment.metadata.tags, tag])),
      },
    };
  }

  protected normalizeSemanticUnit(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }

  protected tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^a-z0-9_/$.-]+/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 3);
  }

  protected clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private captureTelemetry(
    startedAt: number,
    packed: PackedContext,
    compressed: CompressedContext,
    level: CompressionLevel,
    options: CompressionOptions,
    traceId?: string
  ): void {
    this.lastTelemetry = {
      traceId,
      durationMs: Date.now() - startedAt,
      originalTokens: packed.rawTokens,
      finalTokens: compressed.stats.finalTokens,
      level,
      model: options.model,
      query: options.query,
      fragmentsIn: packed.fragments.length,
      fragmentsOut: compressed.fragments.length,
    };
  }
}

export class RepoContextCompressor extends ContextCompressor {
  private repoConfig: RepoCompressionConfig;
  private repoMap: RepoMap | null = null;

  constructor(
    baseStrategy: CompressionStrategy = DEFAULT_STRATEGIES[1],
    repoConfig?: Partial<RepoCompressionConfig>
  ) {
    super(baseStrategy);
    this.repoConfig = {
      baseStrategy,
      includePatterns: repoConfig?.includePatterns ?? [],
      excludePatterns: repoConfig?.excludePatterns ?? ['node_modules/**', '.git/**', '*.log'],
      languageStrategies: repoConfig?.languageStrategies ?? new Map(),
      maxInlineSize: repoConfig?.maxInlineSize ?? 50000,
    };
  }

  setRepoMap(repoMap: RepoMap): void {
    this.repoMap = repoMap;
  }

  compressRepo(files: FileContext[], budget?: number, options: Omit<CompressionOptions, 'budget'> = {}): RepoCompressedContext {
    const targetBudget = budget ?? (options.model ? createBudgetPlan(options.model, options).inputBudget : MODEL_BUDGETS.qwen.effectiveBudget);
    const filteredFiles = this.filterByPatterns(files);
    const processedFiles = this.applySizeStrategy(filteredFiles);
    const packed = this.pack(processedFiles);
    const compressed = this.compressWithOptions(packed, { ...options, budget: targetBudget });

    const includedFiles = compressed.fragments
      .map((fragment) => ('relativePath' in fragment ? fragment.relativePath : undefined))
      .filter((value): value is string => Boolean(value));

    const allPaths = files.map((file) => file.relativePath);
    const omittedFiles = allPaths.filter((path) => !includedFiles.includes(path));

    return {
      content: compressed.content,
      repoMap:
        this.repoMap ?? {
          rootPath: '.',
          fileTree: [],
          symbols: { definitions: new Map(), references: new Map() },
          generatedAt: Date.now(),
        },
      includedFiles,
      omittedFiles,
      metrics: {
        totalFiles: files.length,
        includedFiles: includedFiles.length,
        totalTokens: compressed.stats.originalTokens,
        compressedTokens: compressed.stats.finalTokens,
      },
    };
  }

  compressSessionContext(
    fragments: ContextFragment[],
    session: Pick<Session, 'id' | 'currentTask' | 'taskStack' | 'modelUsage'>,
    options: Omit<CompressionOptions, 'session'> = {}
  ): CompressedContext {
    const packed = this.pack(fragments);
    return this.compressWithOptions(packed, { ...options, session });
  }

  compressForRouter(
    fragments: ContextFragment[],
    request: {
      model: SupportedModel;
      query?: string;
      reservedOutputTokens?: number;
      promptOverheadTokens?: number;
    }
  ): CompressedContext {
    const packed = this.pack(fragments);
    return this.compressWithOptions(packed, {
      model: request.model,
      query: request.query,
      reservedOutputTokens: request.reservedOutputTokens,
      promptOverheadTokens: request.promptOverheadTokens,
      telemetryLabel: 'model-router',
    });
  }

  private filterByPatterns(files: FileContext[]): FileContext[] {
    return files.filter((file) => {
      const path = file.relativePath;

      for (const pattern of this.repoConfig.excludePatterns) {
        if (this.matchPattern(path, pattern)) return false;
      }

      if (this.repoConfig.includePatterns.length > 0) {
        return this.repoConfig.includePatterns.some((pattern) => this.matchPattern(path, pattern));
      }

      return true;
    });
  }

  private matchPattern(path: string, pattern: string): boolean {
    const escapedPattern = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regex = escapedPattern
      .replace(/\*\*/g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/::GLOBSTAR::/g, '.*');

    return new RegExp(`^${regex}$`).test(path);
  }

  private applySizeStrategy(files: FileContext[]): FileContext[] {
    return files.map((file) => {
      if (file.fileSize <= this.repoConfig.maxInlineSize) {
        return file;
      }

      const previewLimit = Math.min(file.content.length, Math.max(500, Math.floor(this.repoConfig.maxInlineSize / 10)));
      const summary = this.generateSummary(file, 12);
      const content = `${summary}\n\nPreview:\n${file.content.slice(0, previewLimit)}\n// ... truncated`;

      return {
        ...file,
        content,
        tokenCount: estimateTokens(content),
        metadata: {
          ...file.metadata,
          tags: Array.from(new Set([...file.metadata.tags, 'summarized'])),
        },
      };
    });
  }
}

export function compressContext(
  fragments: ContextFragment[],
  budget?: number,
  level: CompressionLevel = 1
): CompressedContext {
  const compressor = new ContextCompressor(DEFAULT_STRATEGIES[level]);
  const packed = compressor.pack(fragments);
  return compressor.compressWithOptions(packed, { budget, level });
}

export function compressRepoContext(
  files: FileContext[],
  repoMap: RepoMap,
  budget?: number
): RepoCompressedContext {
  const compressor = new RepoContextCompressor();
  compressor.setRepoMap(repoMap);
  return compressor.compressRepo(files, budget);
}

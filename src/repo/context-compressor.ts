/**
 * Context Compressor
 * Packs and compresses repository context for efficient model consumption
 */

import type {
  ContextFragment,
  PackedContext,
  CompressedContext,
  CompressionStrategy,
  CompressionStats,
  CompressionLevel,
  FragmentType,
  ScoredFragment,
  ModelBudget,
} from '../types/context.js';

import type {
  RepoCompressionConfig,
  RepoCompressedContext,
  RepoMap,
  FileContext,
} from './types.js';

/**
 * Default compression strategies per level
 */
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
    preserveTypes: ['code', 'error', 'system', 'symbol'],
    preserveTags: ['critical', 'error'],
    minPriority: 0.1,
  },
  2: {
    level: 2,
    targetBudget: null,
    preserveTypes: ['code', 'error', 'system'],
    preserveTags: ['critical'],
    minPriority: 0.3,
  },
  3: {
    level: 3,
    targetBudget: null,
    preserveTypes: ['error', 'system'],
    preserveTags: ['critical'],
    minPriority: 0.5,
  },
};

/**
 * Model token budgets
 */
const MODEL_BUDGETS: Record<string, ModelBudget> = {
  qwen: { model: 'qwen', maxTokens: 128000, safetyMargin: 0.1, effectiveBudget: 115200 },
  deepseek: { model: 'deepseek', maxTokens: 64000, safetyMargin: 0.1, effectiveBudget: 57600 },
  gpt: { model: 'gpt', maxTokens: 128000, safetyMargin: 0.15, effectiveBudget: 108800 },
};

/**
 * Estimate token count from text
 * Uses approximate 4 chars per token heuristic
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Context Compressor class
 */
export class ContextCompressor {
  private strategy: CompressionStrategy;

  constructor(strategy: CompressionStrategy = DEFAULT_STRATEGIES[1]) {
    this.strategy = strategy;
  }

  /**
   * Set compression strategy
   */
  setStrategy(strategy: CompressionStrategy): void {
    this.strategy = strategy;
  }

  /**
   * Pack fragments into structured context
   */
  pack(fragments: ContextFragment[]): PackedContext {
    const totalTokens = fragments.reduce(
      (sum, f) => sum + (f.tokenCount ?? estimateTokens(f.content)),
      0
    );

    return {
      fragments: [...fragments],
      rawTokens: totalTokens,
      packedAt: Date.now(),
    };
  }

  /**
   * Compress packed context to fit budget
   */
  compress(packed: PackedContext, budget?: number): CompressedContext {
    const targetBudget = budget ?? this.strategy.targetBudget ?? packed.rawTokens;
    const fragments = [...packed.fragments];

    // If already under budget, apply level 0 (lossless) optimizations only
    if (packed.rawTokens <= targetBudget && this.strategy.level === 0) {
      return this.buildCompressed(packed, fragments, targetBudget);
    }

    // Filter by minimum priority
    let filtered = this.filterByPriority(fragments, this.strategy.minPriority);

    // Filter by preserved types
    filtered = this.filterByTypes(filtered, this.strategy.preserveTypes);

    // Filter by preserved tags
    if (this.strategy.preserveTags.length > 0) {
      filtered = this.filterByTags(filtered, this.strategy.preserveTags);
    }

    // If still over budget, apply truncation
    let currentTokens = this.calculateTokens(filtered);
    if (currentTokens > targetBudget) {
      filtered = this.truncateToBudget(filtered, targetBudget);
    }

    return this.buildCompressed(packed, filtered, targetBudget);
  }

  /**
   * Compress specifically for a model
   */
  compressForModel(
    packed: PackedContext,
    model: keyof typeof MODEL_BUDGETS
  ): CompressedContext {
    const budget = MODEL_BUDGETS[model].effectiveBudget;
    return this.compress(packed, budget);
  }

  /**
   * Filter fragments below minimum priority
   */
  private filterByPriority(
    fragments: ContextFragment[],
    minPriority: number
  ): ContextFragment[] {
    return fragments.filter((f) => f.metadata.priority >= minPriority);
  }

  /**
   * Filter to only specified types
   */
  private filterByTypes(
    fragments: ContextFragment[],
    types: FragmentType[]
  ): ContextFragment[] {
    return fragments.filter((f) => types.includes(f.type));
  }

  /**
   * Filter to fragments with specified tags
   */
  private filterByTags(
    fragments: ContextFragment[],
    tags: string[]
  ): ContextFragment[] {
    return fragments.filter((f) =>
      f.metadata.tags.some((t) => tags.includes(t))
    );
  }

  /**
   * Truncate fragments to fit budget
   * Removes lowest priority fragments first
   */
  private truncateToBudget(
    fragments: ContextFragment[],
    budget: number
  ): ContextFragment[] {
    // Sort by priority descending
    const sorted = [...fragments].sort(
      (a, b) => b.metadata.priority - a.metadata.priority
    );

    const result: ContextFragment[] = [];
    let currentTokens = 0;

    for (const fragment of sorted) {
      const tokens = fragment.tokenCount ?? estimateTokens(fragment.content);
      if (currentTokens + tokens <= budget) {
        result.push(fragment);
        currentTokens += tokens;
      }
    }

    return result;
  }

  /**
   * Calculate total tokens for fragments
   */
  private calculateTokens(fragments: ContextFragment[]): number {
    return fragments.reduce(
      (sum, f) => sum + (f.tokenCount ?? estimateTokens(f.content)),
      0
    );
  }

  /**
   * Build compressed context output
   */
  private buildCompressed(
    original: PackedContext,
    fragments: ContextFragment[],
    targetBudget: number
  ): CompressedContext {
    const finalTokens = this.calculateTokens(fragments);
    const originalTokens = original.rawTokens;

    // Sort fragments for coherent output
    const sortedFragments = this.sortForOutput(fragments);

    // Build content string
    const content = this.formatContent(sortedFragments);

    const stats: CompressionStats = {
      originalTokens,
      finalTokens,
      savedTokens: originalTokens - finalTokens,
      ratio: originalTokens > 0 ? finalTokens / originalTokens : 0,
      fragmentsDropped: original.fragments.length - fragments.length,
      fragmentsSummarized: 0, // Summarization not implemented in v0.1
    };

    return {
      content,
      fragments: sortedFragments,
      stats,
      strategy: this.strategy,
      compressedAt: Date.now(),
    };
  }

  /**
   * Sort fragments for coherent output order
   */
  private sortForOutput(fragments: ContextFragment[]): ContextFragment[] {
    const typeOrder: Record<FragmentType, number> = {
      system: 0,
      error: 1,
      'file-tree': 2,
      doc: 3,
      symbol: 4,
      code: 5,
      chat: 6,
    };

    return [...fragments].sort((a, b) => {
      // First by type order
      const typeDiff = typeOrder[a.type] - typeOrder[b.type];
      if (typeDiff !== 0) return typeDiff;
      // Then by priority (descending)
      return b.metadata.priority - a.metadata.priority;
    });
  }

  /**
   * Format fragments into content string
   */
  private formatContent(fragments: ContextFragment[]): string {
    const sections: string[] = [];

    for (const fragment of fragments) {
      const header = fragment.source
        ? `[${fragment.type}] ${fragment.source}`
        : `[${fragment.type}]`;
      sections.push(`${header}\n${fragment.content}`);
    }

    return sections.join('\n\n---\n\n');
  }
}

/**
 * Repository-specific context compressor
 * Handles repo map integration and file-aware compression
 */
export class RepoContextCompressor extends ContextCompressor {
  private repoConfig: RepoCompression
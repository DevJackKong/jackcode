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
  ModelBudget,
} from '../types/context.js';

import type {
  RepoCompressionConfig,
  RepoCompressedContext,
  RepoMap,
  FileContext,
} from './types.js';

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
    minPriority: 0.25,
  },
  3: {
    level: 3,
    targetBudget: null,
    preserveTypes: ['error', 'system', 'symbol'],
    preserveTags: ['critical'],
    minPriority: 0.5,
  },
};

const MODEL_BUDGETS: Record<'qwen' | 'deepseek' | 'gpt', ModelBudget> = {
  qwen: { model: 'qwen', maxTokens: 128000, safetyMargin: 0.1, effectiveBudget: 115200 },
  deepseek: { model: 'deepseek', maxTokens: 64000, safetyMargin: 0.1, effectiveBudget: 57600 },
  gpt: { model: 'gpt', maxTokens: 128000, safetyMargin: 0.15, effectiveBudget: 108800 },
};

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class ContextCompressor {
  private strategy: CompressionStrategy;

  constructor(strategy: CompressionStrategy = DEFAULT_STRATEGIES[1]) {
    this.strategy = { ...strategy };
  }

  setStrategy(strategy: CompressionStrategy): void {
    this.strategy = { ...strategy };
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
    const targetBudget = Math.max(0, budget ?? this.strategy.targetBudget ?? packed.rawTokens);
    const fragments = [...packed.fragments];

    if (targetBudget === 0) {
      return this.buildCompressed(packed, [], 0);
    }

    if (packed.rawTokens <= targetBudget && this.strategy.level === 0) {
      return this.buildCompressed(packed, fragments, targetBudget);
    }

    const preserved = this.selectPreservedFragments(fragments);
    const others = fragments.filter((fragment) => !preserved.has(fragment.id));

    let filtered = [
      ...Array.from(preserved.values()),
      ...others.filter((fragment) => this.matchesPriority(fragment) && this.matchesType(fragment)),
    ];

    if (this.strategy.preserveTags.length > 0) {
      const preservedByTag = others.filter((fragment) => this.matchesTags(fragment));
      filtered = this.mergeUniqueFragments(filtered, preservedByTag);
    }

    if (this.calculateTokens(filtered) > targetBudget) {
      filtered = this.truncateToBudget(filtered, targetBudget, preserved);
    }

    return this.buildCompressed(packed, filtered, targetBudget);
  }

  compressForModel(packed: PackedContext, model: keyof typeof MODEL_BUDGETS): CompressedContext {
    return this.compress(packed, MODEL_BUDGETS[model].effectiveBudget);
  }

  private selectPreservedFragments(fragments: ContextFragment[]): Map<string, ContextFragment> {
    const preserved = new Map<string, ContextFragment>();

    for (const fragment of fragments) {
      const preserveByType = this.strategy.preserveTypes.includes(fragment.type);
      const preserveByTag = fragment.metadata.tags.some((tag) => this.strategy.preserveTags.includes(tag));
      if (preserveByType || preserveByTag) {
        preserved.set(fragment.id, fragment);
      }
    }

    return preserved;
  }

  private matchesPriority(fragment: ContextFragment): boolean {
    return fragment.metadata.priority >= this.strategy.minPriority;
  }

  private matchesType(fragment: ContextFragment): boolean {
    return this.strategy.preserveTypes.length === 0 || this.strategy.preserveTypes.includes(fragment.type);
  }

  private matchesTags(fragment: ContextFragment): boolean {
    return fragment.metadata.tags.some((tag) => this.strategy.preserveTags.includes(tag));
  }

  private mergeUniqueFragments(
    current: ContextFragment[],
    incoming: ContextFragment[]
  ): ContextFragment[] {
    const merged = new Map(current.map((fragment) => [fragment.id, fragment]));
    for (const fragment of incoming) {
      merged.set(fragment.id, fragment);
    }
    return Array.from(merged.values());
  }

  private truncateToBudget(
    fragments: ContextFragment[],
    budget: number,
    preserved: Map<string, ContextFragment>
  ): ContextFragment[] {
    const sorted = [...fragments].sort((a, b) => {
      const preserveDelta = Number(preserved.has(b.id)) - Number(preserved.has(a.id));
      if (preserveDelta !== 0) return preserveDelta;
      const priorityDelta = b.metadata.priority - a.metadata.priority;
      if (priorityDelta !== 0) return priorityDelta;
      return b.metadata.lastAccess - a.metadata.lastAccess;
    });

    const result: ContextFragment[] = [];
    let currentTokens = 0;

    for (const fragment of sorted) {
      const fragmentTokens = fragment.tokenCount ?? estimateTokens(fragment.content);
      if (result.length === 0 && fragmentTokens > budget) {
        result.push(this.trimFragmentToBudget(fragment, budget));
        break;
      }

      if (currentTokens + fragmentTokens <= budget) {
        result.push(fragment);
        currentTokens += fragmentTokens;
      }
    }

    return result;
  }

  private trimFragmentToBudget(fragment: ContextFragment, budget: number): ContextFragment {
    if (budget <= 0) {
      return { ...fragment, content: '', tokenCount: 0 };
    }

    const maxChars = Math.max(1, budget * 4);
    if (fragment.content.length <= maxChars) {
      return { ...fragment, tokenCount: fragment.tokenCount ?? estimateTokens(fragment.content) };
    }

    const suffix = '\n// ... truncated';
    const trimmedContent = `${fragment.content.slice(0, Math.max(1, maxChars - suffix.length))}${suffix}`;
    return {
      ...fragment,
      content: trimmedContent,
      tokenCount: estimateTokens(trimmedContent),
      metadata: {
        ...fragment.metadata,
        tags: Array.from(new Set([...fragment.metadata.tags, 'truncated'])),
      },
    };
  }

  private calculateTokens(fragments: ContextFragment[]): number {
    return fragments.reduce((sum, fragment) => sum + (fragment.tokenCount ?? estimateTokens(fragment.content)), 0);
  }

  private buildCompressed(
    original: PackedContext,
    fragments: ContextFragment[],
    _targetBudget: number
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
      fragmentsSummarized: sortedFragments.filter((fragment) => fragment.metadata.tags.includes('summarized') || fragment.metadata.tags.includes('truncated')).length,
    };

    return {
      content,
      fragments: sortedFragments,
      stats,
      strategy: { ...this.strategy },
      compressedAt: Date.now(),
    };
  }

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
      const typeDiff = typeOrder[a.type] - typeOrder[b.type];
      if (typeDiff !== 0) return typeDiff;
      const priorityDiff = b.metadata.priority - a.metadata.priority;
      if (priorityDiff !== 0) return priorityDiff;
      return b.metadata.lastAccess - a.metadata.lastAccess;
    });
  }

  private formatContent(fragments: ContextFragment[]): string {
    return fragments
      .map((fragment) => {
        const header = fragment.source ? `[${fragment.type}] ${fragment.source}` : `[${fragment.type}]`;
        return `${header}\n${fragment.content}`;
      })
      .join('\n\n---\n\n');
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

  compressRepo(files: FileContext[], budget?: number): RepoCompressedContext {
    const targetBudget = budget ?? MODEL_BUDGETS.qwen.effectiveBudget;
    const filteredFiles = this.filterByPatterns(files);
    const processedFiles = this.applySizeStrategy(filteredFiles);
    const packed = this.pack(processedFiles);
    const compressed = this.compress(packed, targetBudget);

    const includedFiles = compressed.fragments
      .map((fragment) => ('relativePath' in fragment ? (fragment as FileContext).relativePath : undefined))
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

      const previewLimit = Math.min(file.content.length, Math.max(500, this.repoConfig.maxInlineSize / 10));
      const content = `// File too large (${file.fileSize} bytes), showing first ${previewLimit} chars:\n${file.content.slice(0, previewLimit)}\n// ... truncated`;

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
  return compressor.compress(packed, budget);
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

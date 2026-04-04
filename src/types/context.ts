/**
 * Shared context types for JackCode
 * Cross-module context definitions
 */

/**
 * Types of context fragments
 */
export type FragmentType =
  | 'code'        // Source code
  | 'doc'         // Documentation
  | 'chat'        // Chat history
  | 'error'       // Error messages
  | 'system'      // System prompts
  | 'file-tree'   // Repository structure
  | 'symbol';     // Symbol definitions

/**
 * A single unit of context
 */
export interface ContextFragment {
  /** Unique identifier */
  id: string;
  /** Fragment category */
  type: FragmentType;
  /** Content payload */
  content: string;
  /** Source file/path */
  source?: string;
  /** Creation timestamp */
  timestamp: number;
  /** Estimated token count (optional, computed on demand) */
  tokenCount?: number;
  /** Metadata for ranking/prioritization */
  metadata: FragmentMetadata;
}

/**
 * Metadata for context relevance scoring
 */
export interface FragmentMetadata {
  /** Access frequency (for LRU-like scoring) */
  accessCount: number;
  /** Last access timestamp */
  lastAccess: number;
  /** Explicit priority (0-1, higher = more important) */
  priority: number;
  /** Semantic tags for categorization */
  tags: string[];
}

/**
 * Packed context ready for compression
 */
export interface PackedContext {
  /** Original fragments */
  fragments: ContextFragment[];
  /** Total raw token count before compression */
  rawTokens: number;
  /** Packing timestamp */
  packedAt: number;
}

/**
 * Compression level configuration
 */
export type CompressionLevel = 0 | 1 | 2 | 3;

/**
 * Compression strategy configuration
 */
export interface CompressionStrategy {
  /** Compression aggressiveness */
  level: CompressionLevel;
  /** Target token budget (null = no limit) */
  targetBudget: number | null;
  /** Preserve fragments matching these types */
  preserveTypes: FragmentType[];
  /** Preserve fragments with these tags */
  preserveTags: string[];
  /** Minimum priority to keep (0-1) */
  minPriority: number;
}

/**
 * Compressed context ready for model consumption
 */
export interface CompressedContext {
  /** Processed content string */
  content: string;
  /** Original fragments after filtering */
  fragments: ContextFragment[];
  /** Compression statistics */
  stats: CompressionStats;
  /** Strategy used */
  strategy: CompressionStrategy;
  /** Timestamp */
  compressedAt: number;
}

/**
 * Compression result statistics
 */
export interface CompressionStats {
  /** Original token count */
  originalTokens: number;
  /** Final token count */
  finalTokens: number;
  /** Tokens saved */
  savedTokens: number;
  /** Compression ratio (0-1) */
  ratio: number;
  /** Fragments dropped */
  fragmentsDropped: number;
  /** Fragments summarized */
  fragmentsSummarized: number;
}

/**
 * Fragment with computed relevance score
 */
export interface ScoredFragment extends ContextFragment {
  /** Relevance score (0-1) */
  relevance: number;
  /** Score components for debugging */
  scoreBreakdown: {
    recency: number;
    frequency: number;
    semantic: number;
    priority: number;
  };
}

/**
 * Model-specific context formats
 */
export type ModelFormat = 'qwen' | 'deepseek' | 'gpt';

/**
 * Token budget configuration per model
 */
export interface ModelBudget {
  /** Model identifier */
  model: ModelFormat;
  /** Maximum context tokens */
  maxTokens: number;
  /** Safety margin (fraction to reserve) */
  safetyMargin: number;
  /** Effective budget after margin */
  effectiveBudget: number;
}

/**
 * Relevance Scorer
 * Ranks context fragments by relevance using multiple signals
 */

import type { ContextFragment, ScoredFragment } from '../types/context.js';

/**
 * Scoring weights
 */
interface ScoreWeights {
  /** Recency weight (0-1) */
  recency: number;
  /** Frequency weight (0-1) */
  frequency: number;
  /** Semantic similarity weight (0-1) */
  semantic: number;
  /** Explicit priority weight (0-1) */
  priority: number;
}

/**
 * Default scoring weights
 */
const DEFAULT_WEIGHTS: ScoreWeights = {
  recency: 0.3,
  frequency: 0.2,
  semantic: 0.3,
  priority: 0.2,
};

/**
 * Time decay half-life in milliseconds (1 hour)
 */
const RECENCY_HALF_LIFE = 60 * 60 * 1000;

/**
 * Relevance Scorer class
 */
export class RelevanceScorer {
  private weights: ScoreWeights;

  constructor(weights: Partial<ScoreWeights> = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
  }

  /**
   * Score fragments against a query
   */
  score(fragments: ContextFragment[], query?: string): ScoredFragment[] {
    const now = Date.now();
    const queryTerms = query ? this.tokenize(query) : [];

    return fragments.map((fragment) => {
      const recency = this.calcRecency(fragment.metadata.lastAccess, now);
      const frequency = this.calcFrequency(fragment.metadata.accessCount);
      const semantic = queryTerms.length > 0
        ? this.calcSemantic(fragment.content, queryTerms)
        : 0.5;
      const priority = fragment.metadata.priority;

      const relevance =
        this.weights.recency * recency +
        this.weights.frequency * frequency +
        this.weights.semantic * semantic +
        this.weights.priority * priority;

      return {
        ...fragment,
        relevance,
        scoreBreakdown: {
          recency,
          frequency,
          semantic,
          priority,
        },
      };
    });
  }

  /**
   * Rank fragments by relevance (descending)
   */
  rank(fragments: ContextFragment[], query?: string): ScoredFragment[] {
    const scored = this.score(fragments, query);
    return scored.sort((a, b) => b.relevance - a.relevance);
  }

  /**
   * Get top N fragments by relevance
   */
  topN(
    fragments: ContextFragment[],
    n: number,
    query?: string
  ): ScoredFragment[] {
    return this.rank(fragments, query).slice(0, n);
  }

  /**
   * Filter fragments above relevance threshold
   */
  filterByRelevance(
    fragments: ContextFragment[],
    threshold: number,
    query?: string
  ): ScoredFragment[] {
    const scored = this.score(fragments, query);
    return scored.filter((f) => f.relevance >= threshold);
  }

  /**
   * Calculate recency score using exponential decay
   * 1.0 = now, 0.0 = very old
   */
  private calcRecency(lastAccess: number, now: number): number {
    const age = now - lastAccess;
    if (age < 0) return 1.0; // Future-dated items get max score
    return Math.exp(-age / RECENCY_HALF_LIFE);
  }

  /**
   * Calculate frequency score
   * Log-scaled to prevent runaway scores
   */
  private calcFrequency(accessCount: number): number {
    if (accessCount <= 0) return 0;
    return Math.min(1.0, Math.log10(accessCount + 1) / 3);
  }

  /**
   * Calculate semantic similarity (simple term overlap)
   */
  private calcSemantic(content: string, queryTerms: string[]): number {
    const contentTerms = this.tokenize(content);
    if (contentTerms.length === 0 || queryTerms.length === 0) return 0.5;

    const contentSet = new Set(contentTerms);
    const matches = queryTerms.filter((t) => contentSet.has(t)).length;
    
    return matches / queryTerms.length;
  }

  /**
   * Simple tokenization
   */
  private tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
  }

  /**
   * Update scoring weights
   */
  setWeights(weights: Partial<ScoreWeights>): void {
    this.weights = { ...this.weights, ...weights };
  }

  /**
   * Get current weights
   */
  getWeights(): ScoreWeights {
    return { ...this.weights };
  }
}

/**
 * Quick score function
 */
export function quickScore(
  fragments: ContextFragment[],
  query?: string
): ScoredFragment[] {
  const scorer = new RelevanceScorer();
  return scorer.score(fragments, query);
}

/**
 * Quick rank function
 */
export function quickRank(
  fragments: ContextFragment[],
  query?: string
): ScoredFragment[] {
  const scorer = new RelevanceScorer();
  return scorer.rank(fragments, query);
}

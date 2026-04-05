/**
 * Relevance Scorer
 * Ranks context fragments by relevance using multiple signals
 */
/**
 * Default scoring weights
 */
const DEFAULT_WEIGHTS = {
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
    weights;
    constructor(weights = {}) {
        this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    }
    /**
     * Score fragments against a query
     */
    score(fragments, query) {
        const now = Date.now();
        const queryTerms = query ? this.tokenize(query) : [];
        return fragments.map((fragment) => {
            const recency = this.calcRecency(fragment.metadata.lastAccess, now);
            const frequency = this.calcFrequency(fragment.metadata.accessCount);
            const semantic = queryTerms.length > 0
                ? this.calcSemantic(fragment.content, queryTerms)
                : 0.5;
            const priority = fragment.metadata.priority;
            const relevance = this.weights.recency * recency +
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
    rank(fragments, query) {
        const scored = this.score(fragments, query);
        return scored.sort((a, b) => b.relevance - a.relevance);
    }
    /**
     * Get top N fragments by relevance
     */
    topN(fragments, n, query) {
        return this.rank(fragments, query).slice(0, n);
    }
    /**
     * Filter fragments above relevance threshold
     */
    filterByRelevance(fragments, threshold, query) {
        const scored = this.score(fragments, query);
        return scored.filter((f) => f.relevance >= threshold);
    }
    /**
     * Calculate recency score using exponential decay
     * 1.0 = now, 0.0 = very old
     */
    calcRecency(lastAccess, now) {
        const age = now - lastAccess;
        if (age < 0)
            return 1.0; // Future-dated items get max score
        return Math.exp(-age / RECENCY_HALF_LIFE);
    }
    /**
     * Calculate frequency score
     * Log-scaled to prevent runaway scores
     */
    calcFrequency(accessCount) {
        if (accessCount <= 0)
            return 0;
        return Math.min(1.0, Math.log10(accessCount + 1) / 3);
    }
    /**
     * Calculate semantic similarity (simple term overlap)
     */
    calcSemantic(content, queryTerms) {
        const contentTerms = this.tokenize(content);
        if (contentTerms.length === 0 || queryTerms.length === 0)
            return 0.5;
        const contentSet = new Set(contentTerms);
        const matches = queryTerms.filter((t) => contentSet.has(t)).length;
        return matches / queryTerms.length;
    }
    /**
     * Simple tokenization
     */
    tokenize(text) {
        return text
            .toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter((t) => t.length > 2);
    }
    /**
     * Update scoring weights
     */
    setWeights(weights) {
        this.weights = { ...this.weights, ...weights };
    }
    /**
     * Get current weights
     */
    getWeights() {
        return { ...this.weights };
    }
}
/**
 * Quick score function
 */
export function quickScore(fragments, query) {
    const scorer = new RelevanceScorer();
    return scorer.score(fragments, query);
}
/**
 * Quick rank function
 */
export function quickRank(fragments, query) {
    const scorer = new RelevanceScorer();
    return scorer.rank(fragments, query);
}

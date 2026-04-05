/**
 * Thread 12: Model Policy & Cost Control Types
 * Simplified two-model architecture: Qwen developer + GPT-5.4 auditor.
 */
export const DEFAULT_POLICY_CONFIG = {
    policy: {
        developerModel: 'qwen',
        auditorModel: 'gpt54',
        complexityThresholds: { low: 1000, medium: 10000, high: 50000 },
        costLimits: { perTask: 0.5, perSession: 5.0, perDay: 20.0, perWeek: 100.0, perMonth: 350.0 },
    },
    cacheTtlMs: 300000,
    enableAutoDowngrade: true,
    warningThresholds: { session: 0.7, daily: 0.8, weekly: 0.85, monthly: 0.9 },
    optimization: { cacheReuseThresholdTokens: 4000, batchMinItems: 3, earlyTerminationTokenRatio: 0.35, compressionRatio: 0.75 },
};
export const MODEL_PRICING = {
    qwen: { input: 0.001, output: 0.002 },
    gpt54: { input: 0.015, output: 0.06 },
};
export const MODEL_CAPABILITIES = {
    qwen: {
        tier: 'qwen',
        maxContextTokens: 128000,
        supportsReasoning: true,
        supportsBatching: true,
        averageLatencyMs: 2000,
        accuracyScore: 0.9,
        preferredComplexity: ['low', 'medium', 'high'],
        idealTaskTypes: ['simple_edit', 'build_fix', 'test_fix', 'batch_operation', 'multi_file_change', 'refactor', 'debug'],
    },
    gpt54: {
        tier: 'gpt54',
        maxContextTokens: 256000,
        supportsReasoning: true,
        supportsBatching: false,
        averageLatencyMs: 8000,
        accuracyScore: 0.95,
        preferredComplexity: ['high'],
        idealTaskTypes: ['final_verification', 'architecture_review', 'refactor'],
    },
};

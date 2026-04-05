/**
 * Thread 12: Model Policy & Cost Control Types
 * Simplified two-model architecture: Qwen developer + GPT-5.4 auditor.
 */

export type ModelTier = 'qwen' | 'gpt54';
export type ComplexityScore = 'low' | 'medium' | 'high';
export type TaskType =
  | 'simple_edit'
  | 'multi_file_change'
  | 'refactor'
  | 'debug'
  | 'build_fix'
  | 'test_fix'
  | 'final_verification'
  | 'batch_operation'
  | string;

export type BudgetWindow = 'session' | 'day' | 'week' | 'month' | 'task';
export type OptimizationAction = 'cache_reuse' | 'batching' | 'early_termination' | 'compressed_context';
export type AlertSeverity = 'info' | 'warning' | 'critical';
export type PolicyDecisionMode = 'normal' | 'forced' | 'overridden' | 'downgraded' | 'blocked';

export interface ModelPolicy {
  developerModel: Extract<ModelTier, 'qwen'>;
  auditorModel: Extract<ModelTier, 'gpt54'>;
  complexityThresholds: {
    low: number;
    medium: number;
    high: number;
  };
  costLimits: {
    perTask: number;
    perSession: number;
    perDay: number;
    perWeek: number;
    perMonth: number;
  };
}

export interface PolicyConfig {
  policy: ModelPolicy;
  cacheTtlMs: number;
  enableAutoDowngrade: boolean;
  warningThresholds: {
    session: number;
    daily: number;
    weekly: number;
    monthly: number;
  };
  optimization: {
    cacheReuseThresholdTokens: number;
    batchMinItems: number;
    earlyTerminationTokenRatio: number;
    compressionRatio: number;
  };
}

export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
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

export const MODEL_PRICING: Record<ModelTier, { input: number; output: number }> = {
  qwen: { input: 0.001, output: 0.002 },
  gpt54: { input: 0.015, output: 0.06 },
};

export interface TaskContext {
  taskId: string;
  taskType: TaskType;
  files?: string[];
  intent?: string;
  estimatedTokens?: number;
  complexity?: ComplexityScore;
  requiresReasoning?: boolean;
  failureCount?: number;
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  sessionId?: string;
  maxCostUsd?: number;
  batchable?: boolean;
  batchSize?: number;
  preferCached?: boolean;
  overrideModel?: ModelTier;
  metadata?: Record<string, unknown>;
  qwenConfidence?: number;
  qwenHistoricalSuccessRate?: number;
  architectureChange?: boolean;
}

export interface BudgetStatus {
  allowed: boolean;
  reason: string;
  violatedWindow?: BudgetWindow;
  projectedSpend?: number;
}

export interface PolicyAlert {
  severity: AlertSeverity;
  code: string;
  message: string;
  window?: BudgetWindow;
  createdAt: number;
}

export interface RoutingDecision {
  taskId: string;
  selectedModel: ModelTier;
  reasoning: string;
  estimatedCost: number;
  estimatedTokens: number;
  fallbackOnFailure: boolean;
  mode?: PolicyDecisionMode;
  appliedRules?: string[];
  appliedOptimizations?: OptimizationAction[];
  alerts?: PolicyAlert[];
  budgetStatus?: BudgetStatus;
  overrideApplied?: boolean;
  cacheHit?: boolean;
  batched?: boolean;
  earlyTerminationSuggested?: boolean;
  verificationModel?: Extract<ModelTier, 'gpt54'>;
  qwenAssessment?: {
    confidence: number;
    canHandleComplexity: boolean;
    contextFits: boolean;
    historicalSuccessRate: number | null;
  };
}

export interface TaskCost {
  model: ModelTier;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  taskType?: TaskType;
  sessionId?: string;
  timestamp?: number;
  cached?: boolean;
  batched?: boolean;
  earlyTerminated?: boolean;
}

export interface TokenUsage {
  model: ModelTier;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  cached?: boolean;
  sessionId?: string;
  taskType?: TaskType;
  terminatedEarly?: boolean;
}

export interface CostTracker {
  sessionId: string;
  taskCosts: Map<string, TaskCost>;
  sessionTotal: number;
  dailyTotal: number;
  weeklyTotal: number;
  monthlyTotal: number;
  lastReset: number;
  lastDailyReset: number;
  lastWeeklyReset: number;
  lastMonthlyReset: number;
}

export interface BudgetAllocation {
  allocated: number;
  maxAllowed: number;
  taskType: TaskType;
  approved: boolean;
  reason: string;
  window?: BudgetWindow;
}

export interface BudgetSnapshot {
  perTask: number;
  perSession: number;
  perDay: number;
  perWeek: number;
  perMonth: number;
}

export interface RuleAction {
  modelPreference: ModelTier[];
  forceModel?: boolean;
  costMultiplier?: number;
  optimizations?: OptimizationAction[];
  maxTaskCostUsd?: number;
}

export interface PolicyRule {
  name: string;
  priority: number;
  condition: (task: TaskContext) => boolean;
  action: (task: TaskContext) => RuleAction;
}

export interface RuleResult {
  ruleName: string;
  priority: number;
  action: RuleAction;
}

export interface UsageTrendPoint {
  period: string;
  cost: number;
  tokens: number;
  tasks: number;
}

export interface UsageDashboard {
  totals: {
    sessionCost: number;
    dailyCost: number;
    weeklyCost: number;
    monthlyCost: number;
    totalTasks: number;
    totalTokens: number;
  };
  burnRates: { daily: number; weekly: number; monthly: number };
  budgetUtilization: { session: number; daily: number; weekly: number; monthly: number };
  topModels: Array<{ model: ModelTier; cost: number; tasks: number; tokens: number }>;
  alerts: PolicyAlert[];
}

export interface CostReport {
  sessionId: string;
  summary: { totalTasks: number; totalCost: number; totalTokens: number; averageLatency: number };
  byModel: Record<ModelTier, { count: number; cost: number; tokens: number }>;
  limits: { perTask: number; perSession: number; perDay: number; perWeek: number; perMonth: number };
  remaining: BudgetSnapshot;
  dashboard: UsageDashboard;
  breakdown: {
    byTaskType: Record<string, { count: number; cost: number; tokens: number }>;
    bySession: Record<string, { count: number; cost: number; tokens: number }>;
  };
  trends: { daily: UsageTrendPoint[]; weekly: UsageTrendPoint[]; monthly: UsageTrendPoint[] };
  forecast: { day: number; week: number; month: number };
  export: { json: string; csv: string };
  generatedAt: number;
}

export interface ModelCapabilities {
  tier: ModelTier;
  maxContextTokens: number;
  supportsReasoning: boolean;
  supportsBatching: boolean;
  averageLatencyMs: number;
  accuracyScore: number;
  preferredComplexity?: ComplexityScore[];
  idealTaskTypes?: string[];
}

export const MODEL_CAPABILITIES: Record<ModelTier, ModelCapabilities> = {
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

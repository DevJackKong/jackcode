/**
 * Thread 12: Model Policy & Cost Control Types
 * Type definitions for model selection, routing rules, and cost management
 */

/** Available model tiers */
export type ModelTier = 'qwen' | 'deepseek' | 'gpt54';

/** Task complexity levels */
export type ComplexityScore = 'low' | 'medium' | 'high';

/** Task types for policy decisions */
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

/** Core model policy configuration */
export interface ModelPolicy {
  /** Default model when no rules match */
  defaultModel: ModelTier;
  /** Token thresholds for complexity classification */
  complexityThresholds: {
    low: number;
    medium: number;
    high: number;
  };
  /** Cost limits in USD */
  costLimits: {
    perTask: number;
    perSession: number;
    perDay: number;
    perWeek: number;
    perMonth: number;
  };
  /** Model escalation chain (cheapest to most expensive) */
  escalationChain: ModelTier[];
}

/** Complete policy configuration */
export interface PolicyConfig {
  policy: ModelPolicy;
  /** Cache TTL in milliseconds */
  cacheTtlMs: number;
  /** Enable automatic downgrades on budget pressure */
  enableAutoDowngrade: boolean;
  /** Budget warning thresholds (0-1) */
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

/** Default policy configuration */
export const DEFAULT_POLICY_CONFIG: PolicyConfig = {
  policy: {
    defaultModel: 'qwen',
    complexityThresholds: {
      low: 1000,
      medium: 10000,
      high: 50000,
    },
    costLimits: {
      perTask: 0.5,
      perSession: 5.0,
      perDay: 20.0,
      perWeek: 100.0,
      perMonth: 350.0,
    },
    escalationChain: ['qwen', 'deepseek', 'gpt54'],
  },
  cacheTtlMs: 300000, // 5 minutes
  enableAutoDowngrade: true,
  warningThresholds: {
    session: 0.7,
    daily: 0.8,
    weekly: 0.85,
    monthly: 0.9,
  },
  optimization: {
    cacheReuseThresholdTokens: 4000,
    batchMinItems: 3,
    earlyTerminationTokenRatio: 0.35,
    compressionRatio: 0.75,
  },
};

/** Pricing per 1K tokens for each model */
export const MODEL_PRICING: Record<ModelTier, { input: number; output: number }> = {
  qwen: { input: 0.001, output: 0.002 },      // $0.002 avg per 1K
  deepseek: { input: 0.002, output: 0.008 },  // $0.005 avg per 1K
  gpt54: { input: 0.015, output: 0.06 },      // $0.03 avg per 1K
};

/** Task context for policy evaluation */
export interface TaskContext {
  taskId: string;
  taskType: TaskType;
  /** Files involved in task */
  files?: string[];
  /** Human-readable intent */
  intent?: string;
  /** Estimated token count (if known) */
  estimatedTokens?: number;
  /** Explicit complexity override */
  complexity?: ComplexityScore;
  /** Whether task requires deep reasoning */
  requiresReasoning?: boolean;
  /** Previous failure count for this task */
  failureCount?: number;
  /** Urgency level */
  urgency?: 'low' | 'normal' | 'high' | 'critical';
  /** Optional existing session id */
  sessionId?: string;
  /** Optional task-specific budget override */
  maxCostUsd?: number;
  /** Hint that similar tasks are batchable */
  batchable?: boolean;
  /** Approximate count of similar tasks in the batch */
  batchSize?: number;
  /** Prefer using cached outputs if possible */
  preferCached?: boolean;
  /** Optional model override request */
  overrideModel?: ModelTier;
  /** Extra metadata for custom policy rules */
  metadata?: Record<string, unknown>;
}

/** Routing decision output */
export interface RoutingDecision {
  taskId: string;
  selectedModel: ModelTier;
  /** Human-readable reasoning */
  reasoning: string;
  /** Estimated cost in USD */
  estimatedCost: number;
  /** Estimated token usage */
  estimatedTokens: number;
  /** Whether fallback is allowed on failure */
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
}

/** Cost tracking state */
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

/** Individual task cost record */
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

/** Token usage report */
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

/** Budget check result */
export interface BudgetStatus {
  allowed: boolean;
  reason: string;
  violatedWindow?: BudgetWindow;
  projectedSpend?: number;
}

/** Budget allocation response */
export interface BudgetAllocation {
  allocated: number;
  maxAllowed: number;
  taskType: TaskType;
  approved: boolean;
  reason: string;
  window?: BudgetWindow;
}

/** Budget snapshot */
export interface BudgetSnapshot {
  perTask: number;
  perSession: number;
  perDay: number;
  perWeek: number;
  perMonth: number;
}

/** Policy rule definition */
export interface PolicyRule {
  name: string;
  priority: number;
  condition: (task: TaskContext) => boolean;
  action: (task: TaskContext) => RuleAction;
}

/** Rule action result */
export interface RuleAction {
  /** Preferred models in order */
  modelPreference: ModelTier[];
  /** Force this preference (ignore other rules) */
  forceModel?: boolean;
  /** Additional cost multiplier */
  costMultiplier?: number;
  /** Suggested optimization hints */
  optimizations?: OptimizationAction[];
  /** Override max task cost */
  maxTaskCostUsd?: number;
}

/** Rule evaluation result */
export interface RuleResult {
  ruleName: string;
  priority: number;
  action: RuleAction;
}

export interface PolicyAlert {
  severity: AlertSeverity;
  code: string;
  message: string;
  window?: BudgetWindow;
  createdAt: number;
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
  burnRates: {
    daily: number;
    weekly: number;
    monthly: number;
  };
  budgetUtilization: {
    session: number;
    daily: number;
    weekly: number;
    monthly: number;
  };
  topModels: Array<{ model: ModelTier; cost: number; tasks: number; tokens: number }>;
  alerts: PolicyAlert[];
}

/** Cost report structure */
export interface CostReport {
  sessionId: string;
  summary: {
    totalTasks: number;
    totalCost: number;
    totalTokens: number;
    averageLatency: number;
  };
  byModel: Record<ModelTier, { count: number; cost: number; tokens: number }>;
  limits: {
    perTask: number;
    perSession: number;
    perDay: number;
    perWeek: number;
    perMonth: number;
  };
  remaining: BudgetSnapshot;
  dashboard: UsageDashboard;
  breakdown: {
    byTaskType: Record<string, { count: number; cost: number; tokens: number }>;
    bySession: Record<string, { count: number; cost: number; tokens: number }>;
  };
  trends: {
    daily: UsageTrendPoint[];
    weekly: UsageTrendPoint[];
    monthly: UsageTrendPoint[];
  };
  forecast: {
    day: number;
    week: number;
    month: number;
  };
  export: {
    json: string;
    csv: string;
  };
  generatedAt: number;
}

/** Escalation decision */
export interface EscalationDecision {
  shouldEscalate: boolean;
  from: ModelTier;
  to: ModelTier;
  reason: string;
  estimatedAdditionalCost: number;
}

/** Model capabilities */
export interface ModelCapabilities {
  tier: ModelTier;
  maxContextTokens: number;
  supportsReasoning: boolean;
  supportsBatching: boolean;
  averageLatencyMs: number;
  accuracyScore: number; // 0-1
}

/** Model capability registry */
export const MODEL_CAPABILITIES: Record<ModelTier, ModelCapabilities> = {
  qwen: {
    tier: 'qwen',
    maxContextTokens: 128000,
    supportsReasoning: false,
    supportsBatching: true,
    averageLatencyMs: 2000,
    accuracyScore: 0.85,
  },
  deepseek: {
    tier: 'deepseek',
    maxContextTokens: 64000,
    supportsReasoning: true,
    supportsBatching: true,
    averageLatencyMs: 5000,
    accuracyScore: 0.90,
  },
  gpt54: {
    tier: 'gpt54',
    maxContextTokens: 256000,
    supportsReasoning: true,
    supportsBatching: false,
    averageLatencyMs: 8000,
    accuracyScore: 0.95,
  },
};

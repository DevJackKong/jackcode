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
    },
    escalationChain: ['qwen', 'deepseek', 'gpt54'],
  },
  cacheTtlMs: 300000, // 5 minutes
  enableAutoDowngrade: true,
  warningThresholds: {
    session: 0.7,
    daily: 0.8,
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
}

/** Cost tracking state */
export interface CostTracker {
  sessionId: string;
  taskCosts: Map<string, TaskCost>;
  sessionTotal: number;
  dailyTotal: number;
  lastReset: number;
}

/** Individual task cost record */
export interface TaskCost {
  model: ModelTier;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
}

/** Token usage report */
export interface TokenUsage {
  model: ModelTier;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

/** Budget check result */
export interface BudgetStatus {
  allowed: boolean;
  reason: string;
}

/** Budget allocation response */
export interface BudgetAllocation {
  allocated: number;
  maxAllowed: number;
  taskType: TaskType;
  approved: boolean;
  reason: string;
}

/** Budget snapshot */
export interface BudgetSnapshot {
  perTask: number;
  perSession: number;
  perDay: number;
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
}

/** Rule evaluation result */
export interface RuleResult {
  ruleName: string;
  priority: number;
  action: RuleAction;
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
  };
  remaining: BudgetSnapshot;
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

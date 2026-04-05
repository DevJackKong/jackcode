/**
 * Thread 12: Model Policy & Cost Control
 * Central policy engine for model selection, routing rules, and cost management
 */

import type {
  BudgetAllocation,
  BudgetSnapshot,
  BudgetStatus,
  ComplexityScore,
  CostReport,
  CostTracker,
  ModelTier,
  PolicyConfig,
  PolicyRule,
  RoutingDecision,
  RuleResult,
  TaskContext,
  TaskCost,
  TaskType,
  TokenUsage,
} from './types/policy.js';

import {
  DEFAULT_POLICY_CONFIG,
  MODEL_CAPABILITIES,
  MODEL_PRICING,
} from './types/policy.js';

interface DecisionCacheEntry {
  decision: RoutingDecision;
  createdAt: number;
}

interface ModelCostBreakdown {
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
}

/**
 * Model Policy Engine
 * Determines optimal model selection based on task characteristics and cost constraints
 */
export class ModelPolicyEngine {
  private config: PolicyConfig;
  private costTracker: CostTracker;
  private decisionCache: Map<string, DecisionCacheEntry> = new Map();
  private rules: PolicyRule[] = [];

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = {
      ...DEFAULT_POLICY_CONFIG,
      ...config,
      policy: {
        ...DEFAULT_POLICY_CONFIG.policy,
        ...config.policy,
      },
      warningThresholds: {
        ...DEFAULT_POLICY_CONFIG.warningThresholds,
        ...config.warningThresholds,
      },
    };
    this.costTracker = this.initializeCostTracker();
    this.registerDefaultRules();
  }

  /**
   * Main entry: select optimal model for a task
   */
  selectModel(task: TaskContext): RoutingDecision {
    this.resetDailyBudgetIfNeeded();

    const cacheKey = this.generateTaskSignature(task);
    const cached = this.decisionCache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      return {
        ...cached.decision,
        reasoning: `${cached.decision.reasoning} (cached)`,
      };
    }

    const ruleResults = this.evaluateRules(task);
    const complexity = this.assessComplexity(task);
    const preferredModel = this.pickModelTier(task, complexity, ruleResults);
    const estimatedTokens = this.estimateTokenUsage(task, preferredModel);

    const decision = this.buildDecision(
      task,
      complexity,
      ruleResults,
      preferredModel,
      estimatedTokens
    );
    const enforced = this.enforceLimits(decision, task, complexity, ruleResults);

    this.decisionCache.set(cacheKey, {
      decision: enforced,
      createdAt: Date.now(),
    });

    return enforced;
  }

  /**
   * Check if a cost is within budget
   */
  checkBudget(cost: number): BudgetStatus {
    this.resetDailyBudgetIfNeeded();

    const limits = this.config.policy.costLimits;

    if (cost > limits.perTask) {
      return { allowed: false, reason: 'per_task_limit_exceeded' };
    }
    if (this.costTracker.sessionTotal + cost > limits.perSession) {
      return { allowed: false, reason: 'session_limit_exceeded' };
    }
    if (this.costTracker.dailyTotal + cost > limits.perDay) {
      return { allowed: false, reason: 'daily_limit_exceeded' };
    }

    return { allowed: true, reason: 'within_budget' };
  }

  /**
   * Track actual token usage and cost
   */
  trackUsage(taskId: string, usage: TokenUsage): TaskCost {
    this.resetDailyBudgetIfNeeded();

    const taskCost: TaskCost = {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: this.calculateActualCost(usage),
      latencyMs: usage.latencyMs,
    };

    const previous = this.costTracker.taskCosts.get(taskId);
    if (previous) {
      this.costTracker.sessionTotal -= previous.costUsd;
      this.costTracker.dailyTotal -= previous.costUsd;
    }

    this.costTracker.taskCosts.set(taskId, taskCost);
    this.costTracker.sessionTotal += taskCost.costUsd;
    this.costTracker.dailyTotal += taskCost.costUsd;

    return taskCost;
  }

  /**
   * Generate cost report for current session
   */
  getCostReport(): CostReport {
    this.resetDailyBudgetIfNeeded();

    const tasks = Array.from(this.costTracker.taskCosts.values());
    const byModel = this.aggregateByModel(tasks);

    return {
      sessionId: this.costTracker.sessionId,
      summary: {
        totalTasks: tasks.length,
        totalCost: this.costTracker.sessionTotal,
        totalTokens: tasks.reduce(
          (sum, task) => sum + task.inputTokens + task.outputTokens,
          0
        ),
        averageLatency:
          tasks.length > 0
            ? tasks.reduce((sum, task) => sum + task.latencyMs, 0) / tasks.length
            : 0,
      },
      byModel,
      limits: {
        perTask: this.config.policy.costLimits.perTask,
        perSession: this.config.policy.costLimits.perSession,
        perDay: this.config.policy.costLimits.perDay,
      },
      remaining: this.getRemainingBudget(),
      generatedAt: Date.now(),
    };
  }

  /**
   * Enforce budget limits on a routing decision
   */
  enforceLimits(
    decision: RoutingDecision,
    task?: TaskContext,
    complexity?: ComplexityScore,
    ruleResults: RuleResult[] = []
  ): RoutingDecision {
    const budget = this.checkBudget(decision.estimatedCost);

    if (budget.allowed) {
      return decision;
    }

    if (!this.config.enableAutoDowngrade) {
      return {
        ...decision,
        fallbackOnFailure: false,
        reasoning: `${decision.reasoning} | Blocked by ${budget.reason}`,
      };
    }

    let candidate = this.downgradeModel(decision.selectedModel);

    while (candidate !== decision.selectedModel) {
      const adjustedTokens = task
        ? this.estimateTokenUsage(task, candidate)
        : decision.estimatedTokens;
      const candidateCost = this.calculateCost(candidate, adjustedTokens);
      const candidateBudget = this.checkBudget(candidateCost);

      if (candidateBudget.allowed) {
        return {
          ...decision,
          selectedModel: candidate,
          estimatedTokens: adjustedTokens,
          estimatedCost: candidateCost,
          fallbackOnFailure: this.shouldAllowFallback(candidate),
          reasoning: `${this.buildReasoning(
            complexity ?? 'medium',
            ruleResults,
            candidate
          )} | Downgraded due to ${budget.reason}`,
        };
      }

      const nextCandidate = this.downgradeModel(candidate);
      if (nextCandidate === candidate) {
        break;
      }
      candidate = nextCandidate;
    }

    return {
      ...decision,
      fallbackOnFailure: false,
      reasoning: `${decision.reasoning} | WARNING: ${budget.reason}`,
    };
  }

  /**
   * Allocate budget for a task
   */
  allocateBudget(taskType: TaskType): BudgetAllocation {
    const baseEstimate = this.getBaseCostEstimate(taskType);
    const status = this.checkBudget(baseEstimate);

    return {
      allocated: status.allowed ? baseEstimate : 0,
      maxAllowed: this.getRemainingBudget().perTask,
      taskType,
      approved: status.allowed,
      reason: status.reason,
    };
  }

  /**
   * Get remaining budget across all tiers
   */
  getRemainingBudget(): BudgetSnapshot {
    this.resetDailyBudgetIfNeeded();

    return {
      perTask: this.config.policy.costLimits.perTask,
      perSession: Math.max(
        0,
        this.config.policy.costLimits.perSession - this.costTracker.sessionTotal
      ),
      perDay: Math.max(
        0,
        this.config.policy.costLimits.perDay - this.costTracker.dailyTotal
      ),
    };
  }

  /**
   * Register a custom policy rule
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Clear decision cache
   */
  clearCache(): void {
    this.decisionCache.clear();
  }

  /**
   * Reset cost tracking for new session
   */
  resetSession(sessionId: string): void {
    this.resetDailyBudgetIfNeeded();

    this.costTracker = {
      sessionId,
      taskCosts: new Map(),
      sessionTotal: 0,
      dailyTotal: this.costTracker.dailyTotal,
      lastReset: this.costTracker.lastReset,
    };
    this.decisionCache.clear();
  }

  private initializeCostTracker(): CostTracker {
    return {
      sessionId: `session_${Date.now()}`,
      taskCosts: new Map(),
      sessionTotal: 0,
      dailyTotal: 0,
      lastReset: Date.now(),
    };
  }

  private generateTaskSignature(task: TaskContext): string {
    const files = [...(task.files ?? [])].sort().join(',');
    const intent = task.intent?.trim().toLowerCase().slice(0, 100) ?? '';
    const complexity = task.complexity ?? 'auto';
    const tokenEstimate = task.estimatedTokens ?? 0;
    const reasoning = task.requiresReasoning ? 'reasoning' : 'standard';

    return [
      task.taskType,
      files,
      intent,
      complexity,
      String(tokenEstimate),
      reasoning,
    ].join(':');
  }

  private isCacheValid(entry: DecisionCacheEntry): boolean {
    if (Date.now() - entry.createdAt > this.config.cacheTtlMs) {
      return false;
    }

    const status = this.checkBudget(entry.decision.estimatedCost);
    return status.allowed;
  }

  private registerDefaultRules(): void {
    this.addRule({
      name: 'critical_path_prefer_cheap',
      priority: 100,
      condition: (task) =>
        task.taskType === 'build_fix' || task.taskType === 'test_fix',
      action: () => ({ modelPreference: ['qwen', 'deepseek', 'gpt54'] }),
    });

    this.addRule({
      name: 'verification_requires_gpt54',
      priority: 95,
      condition: (task) => task.taskType === 'final_verification',
      action: () => ({ modelPreference: ['gpt54'], forceModel: true }),
    });

    this.addRule({
      name: 'complex_tasks_require_reasoning',
      priority: 90,
      condition: (task) =>
        task.complexity === 'high' || task.requiresReasoning === true,
      action: () => ({ modelPreference: ['deepseek', 'gpt54'] }),
    });

    this.addRule({
      name: 'batch_prefer_qwen',
      priority: 80,
      condition: (task) => (task.files?.length ?? 0) > 3,
      action: () => ({ modelPreference: ['qwen', 'deepseek'] }),
    });
  }

  private evaluateRules(task: TaskContext): RuleResult[] {
    return this.rules
      .filter((rule) => rule.condition(task))
      .map((rule) => ({
        ruleName: rule.name,
        priority: rule.priority,
        action: rule.action(task),
      }));
  }

  private assessComplexity(task: TaskContext): ComplexityScore {
    if (task.complexity) {
      return task.complexity;
    }

    let score = 0;

    const fileCount = task.files?.length ?? 0;
    if (fileCount <= 1) score += 1;
    else if (fileCount <= 3) score += 2;
    else score += 3;

    const contextSize = task.estimatedTokens ?? 0;
    const thresholds = this.config.policy.complexityThresholds;
    if (contextSize <= thresholds.low) score += 1;
    else if (contextSize <= thresholds.medium) score += 2;
    else score += 3;

    switch (task.taskType) {
      case 'simple_edit':
        score += 1;
        break;
      case 'multi_file_change':
      case 'batch_operation':
        score += 2;
        break;
      case 'refactor':
      case 'debug':
      case 'final_verification':
        score += 3;
        break;
      default:
        score += 2;
    }

    if (task.requiresReasoning) {
      score += 1;
    }

    if ((task.failureCount ?? 0) >= 2) {
      score += 1;
    }

    if (score <= 4) return 'low';
    if (score <= 7) return 'medium';
    return 'high';
  }

  private pickModelTier(
    task: TaskContext,
    complexity: ComplexityScore,
    rules: RuleResult[]
  ): ModelTier {
    const forcedRule = rules.find((result) => result.action.forceModel);
    if (forcedRule) {
      const forcedModel = forcedRule.action.modelPreference.find((model) =>
        this.canModelHandleTask(model, task)
      );
      if (forcedModel) {
        return forcedModel;
      }
    }

    const preferredModels = rules.flatMap((result) => result.action.modelPreference);
    for (const model of preferredModels) {
      if (this.canModelHandleTask(model, task)) {
        return model;
      }
    }

    const sessionSpendRatio =
      this.config.policy.costLimits.perSession > 0
        ? this.costTracker.sessionTotal / this.config.policy.costLimits.perSession
        : 0;
    const dailySpendRatio =
      this.config.policy.costLimits.perDay > 0
        ? this.costTracker.dailyTotal / this.config.policy.costLimits.perDay
        : 0;
    const underBudgetPressure =
      sessionSpendRatio >= this.config.warningThresholds.session ||
      dailySpendRatio >= this.config.warningThresholds.daily;

    switch (complexity) {
      case 'low':
        return 'qwen';
      case 'medium':
        return underBudgetPressure ? 'qwen' : 'deepseek';
      case 'high':
        if (task.requiresReasoning === false) {
          return 'deepseek';
        }
        return underBudgetPressure ? 'deepseek' : 'gpt54';
      default:
        return this.config.policy.defaultModel;
    }
  }

  private canModelHandleTask(model: ModelTier, task: TaskContext): boolean {
    const capabilities = MODEL_CAPABILITIES[model];
    const estimatedTokens = task.estimatedTokens ?? 0;

    if (estimatedTokens > capabilities.maxContextTokens) {
      return false;
    }
    if (task.requiresReasoning && !capabilities.supportsReasoning) {
      return false;
    }
    if ((task.files?.length ?? 0) > 1 && !capabilities.supportsBatching) {
      return false;
    }

    return true;
  }

  private estimateTokenUsage(task: TaskContext, model: ModelTier): number {
    const baseTokens = Math.max(1, task.estimatedTokens ?? 2000);

    switch (model) {
      case 'qwen':
        return Math.ceil(baseTokens);
      case 'deepseek':
        return Math.ceil(baseTokens * 1.1);
      case 'gpt54':
        return Math.ceil(baseTokens * 1.05);
      default:
        return baseTokens;
    }
  }

  private calculateCost(model: ModelTier, totalTokens: number): number {
    const { totalCost } = this.calculateEstimatedCostBreakdown(model, totalTokens);
    return totalCost;
  }

  private calculateEstimatedCostBreakdown(
    model: ModelTier,
    totalTokens: number
  ): ModelCostBreakdown {
    const pricing = MODEL_PRICING[model];
    const normalizedTokens = Math.max(1, totalTokens);
    const inputTokens = Math.ceil(normalizedTokens * 0.75);
    const outputTokens = Math.max(0, normalizedTokens - inputTokens);
    const totalCost =
      (inputTokens / 1000) * pricing.input +
      (outputTokens / 1000) * pricing.output;

    return { inputTokens, outputTokens, totalCost };
  }

  private calculateActualCost(usage: TokenUsage): number {
    const pricing = MODEL_PRICING[usage.model];
    return (
      (usage.inputTokens / 1000) * pricing.input +
      (usage.outputTokens / 1000) * pricing.output
    );
  }

  private buildReasoning(
    complexity: ComplexityScore,
    rules: RuleResult[],
    model: ModelTier
  ): string {
    const parts: string[] = [`Complexity: ${complexity}`];
    if (rules.length > 0) {
      parts.push(`Rules: ${rules.map((rule) => rule.ruleName).join(', ')}`);
    }
    parts.push(`Selected: ${model}`);
    return parts.join(' | ');
  }

  private shouldAllowFallback(model: ModelTier): boolean {
    return model !== 'gpt54';
  }

  private downgradeModel(model: ModelTier): ModelTier {
    const chain = this.config.policy.escalationChain;
    const index = chain.indexOf(model);
    if (index > 0) {
      return chain[index - 1];
    }
    return model;
  }

  private buildDecision(
    task: TaskContext,
    complexity: ComplexityScore,
    ruleResults: RuleResult[],
    model: ModelTier,
    estimatedTokens: number
  ): RoutingDecision {
    return {
      taskId: task.taskId,
      selectedModel: model,
      reasoning: this.buildReasoning(complexity, ruleResults, model),
      estimatedCost: this.calculateCost(model, estimatedTokens),
      estimatedTokens,
      fallbackOnFailure: this.shouldAllowFallback(model),
    };
  }

  private getBaseCostEstimate(taskType: TaskType): number {
    switch (taskType) {
      case 'simple_edit':
        return 0.005;
      case 'multi_file_change':
      case 'batch_operation':
        return 0.02;
      case 'refactor':
        return 0.05;
      case 'debug':
      case 'build_fix':
      case 'test_fix':
        return 0.03;
      case 'final_verification':
        return 0.1;
      default:
        return 0.02;
    }
  }

  private aggregateByModel(
    tasks: TaskCost[]
  ): Record<ModelTier, { count: number; cost: number; tokens: number }> {
    const result: Record<ModelTier, { count: number; cost: number; tokens: number }> = {
      qwen: { count: 0, cost: 0, tokens: 0 },
      deepseek: { count: 0, cost: 0, tokens: 0 },
      gpt54: { count: 0, cost: 0, tokens: 0 },
    };

    for (const task of tasks) {
      result[task.model].count += 1;
      result[task.model].cost += task.costUsd;
      result[task.model].tokens += task.inputTokens + task.outputTokens;
    }

    return result;
  }

  private resetDailyBudgetIfNeeded(): void {
    const lastResetDate = new Date(this.costTracker.lastReset).toDateString();
    const currentDate = new Date().toDateString();

    if (lastResetDate !== currentDate) {
      this.costTracker.dailyTotal = 0;
      this.costTracker.lastReset = Date.now();
    }
  }
}

/**
 * Singleton policy engine instance
 */
export const modelPolicyEngine = new ModelPolicyEngine();

/**
 * Factory for creating custom policy engines
 */
export function createModelPolicyEngine(
  config?: Partial<PolicyConfig>
): ModelPolicyEngine {
  return new ModelPolicyEngine(config);
}

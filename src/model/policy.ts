/**
 * Thread 12: Model Policy & Cost Control
 * Central policy engine for model selection, routing rules, and cost management
 */

import type {
  BudgetAllocation,
  BudgetSnapshot,
  BudgetStatus,
  BudgetWindow,
  ComplexityScore,
  CostReport,
  CostTracker,
  ModelTier,
  OptimizationAction,
  PolicyAlert,
  PolicyConfig,
  PolicyRule,
  RoutingDecision,
  RuleResult,
  TaskContext,
  TaskCost,
  TaskType,
  TokenUsage,
  UsageDashboard,
  UsageTrendPoint,
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

interface CostHistoryEntry extends TaskCost {
  taskId: string;
  taskType: TaskType;
  sessionId: string;
  timestamp: number;
}

interface PolicyUpdate {
  policy?: Partial<PolicyConfig['policy']>;
  warningThresholds?: Partial<PolicyConfig['warningThresholds']>;
  optimization?: Partial<PolicyConfig['optimization']>;
  cacheTtlMs?: number;
  enableAutoDowngrade?: boolean;
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
  private costHistory: CostHistoryEntry[] = [];
  private alerts: PolicyAlert[] = [];
  private taskBudgets: Map<string, number> = new Map();

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = this.mergeConfig(config);
    this.validatePolicyConfig(this.config);
    this.costTracker = this.initializeCostTracker();
    this.registerDefaultRules();
  }

  /**
   * Main entry: select optimal model for a task
   */
  selectModel(task: TaskContext): RoutingDecision {
    this.resetBudgetsIfNeeded();

    const cacheKey = this.generateTaskSignature(task);
    const cached = this.decisionCache.get(cacheKey);
    if (cached && this.isCacheValid(cached, task)) {
      return {
        ...cached.decision,
        reasoning: `${cached.decision.reasoning} (cached)`,
        cacheHit: true,
        appliedOptimizations: this.addOptimization(
          cached.decision.appliedOptimizations,
          'cache_reuse'
        ),
        alerts: this.buildAlertsForTask(task),
        budgetStatus: this.checkBudget(cached.decision.estimatedCost, task),
      };
    }

    const ruleResults = this.evaluateRules(task);
    const complexity = this.assessComplexity(task);
    const selectedModel = this.pickModelTier(task, complexity, ruleResults);
    const estimatedTokens = this.estimateOptimizedTokenUsage(task, selectedModel, ruleResults);

    const decision = this.buildDecision(
      task,
      complexity,
      ruleResults,
      selectedModel,
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
  checkBudget(cost: number, task?: TaskContext): BudgetStatus {
    this.resetBudgetsIfNeeded();

    const limits = this.getEffectiveLimits(task);
    const checks: Array<{ allowed: boolean; reason: string; window?: BudgetWindow; projectedSpend?: number }> = [
      {
        allowed: cost <= limits.perTask,
        reason: 'per_task_limit_exceeded',
        window: 'task',
        projectedSpend: cost,
      },
      {
        allowed: this.costTracker.sessionTotal + cost <= limits.perSession,
        reason: 'session_limit_exceeded',
        window: 'session',
        projectedSpend: this.costTracker.sessionTotal + cost,
      },
      {
        allowed: this.costTracker.dailyTotal + cost <= limits.perDay,
        reason: 'daily_limit_exceeded',
        window: 'day',
        projectedSpend: this.costTracker.dailyTotal + cost,
      },
      {
        allowed: this.costTracker.weeklyTotal + cost <= limits.perWeek,
        reason: 'weekly_limit_exceeded',
        window: 'week',
        projectedSpend: this.costTracker.weeklyTotal + cost,
      },
      {
        allowed: this.costTracker.monthlyTotal + cost <= limits.perMonth,
        reason: 'monthly_limit_exceeded',
        window: 'month',
        projectedSpend: this.costTracker.monthlyTotal + cost,
      },
    ];

    const blocked = checks.find((entry) => !entry.allowed);
    if (blocked) {
      return {
        allowed: false,
        reason: blocked.reason,
        violatedWindow: blocked.window,
        projectedSpend: blocked.projectedSpend,
      };
    }

    return { allowed: true, reason: 'within_budget', projectedSpend: cost };
  }

  /**
   * Track actual token usage and cost
   */
  trackUsage(taskId: string, usage: TokenUsage): TaskCost {
    this.resetBudgetsIfNeeded();

    const now = Date.now();
    const taskCost: TaskCost = {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: usage.cached ? 0 : this.calculateActualCost(usage),
      latencyMs: usage.latencyMs,
      taskType: usage.taskType,
      sessionId: usage.sessionId ?? this.costTracker.sessionId,
      timestamp: now,
      cached: usage.cached,
      earlyTerminated: usage.terminatedEarly,
    };

    const previous = this.costTracker.taskCosts.get(taskId);
    if (previous) {
      this.applyCostDelta(-previous.costUsd);
      this.removeHistory(taskId);
    }

    this.costTracker.taskCosts.set(taskId, taskCost);
    this.applyCostDelta(taskCost.costUsd);
    this.costHistory.push({
      taskId,
      taskType: taskCost.taskType ?? 'unknown',
      sessionId: taskCost.sessionId ?? this.costTracker.sessionId,
      timestamp: taskCost.timestamp ?? now,
      ...taskCost,
    });

    this.refreshAlerts();
    return taskCost;
  }

  /**
   * Generate cost report for current session
   */
  getCostReport(): CostReport {
    this.resetBudgetsIfNeeded();

    const tasks = Array.from(this.costTracker.taskCosts.values());
    const byModel = this.aggregateByModel(tasks);
    const breakdown = this.buildBreakdown();
    const trends = this.buildTrends();
    const dashboard = this.buildDashboard(byModel);
    const forecast = this.forecastUsage();

    const report: Omit<CostReport, 'export'> = {
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
        perWeek: this.config.policy.costLimits.perWeek,
        perMonth: this.config.policy.costLimits.perMonth,
      },
      remaining: this.getRemainingBudget(),
      dashboard,
      breakdown,
      trends,
      forecast,
      generatedAt: Date.now(),
    };

    return {
      ...report,
      export: {
        json: JSON.stringify(report, null, 2),
        csv: this.toCsv(),
      },
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
    const budget = this.checkBudget(decision.estimatedCost, task);
    const alerts = this.buildAlertsForTask(task);

    if (budget.allowed) {
      return {
        ...decision,
        mode: decision.overrideApplied ? 'overridden' : decision.mode ?? 'normal',
        budgetStatus: budget,
        alerts,
      };
    }

    if (!this.config.enableAutoDowngrade) {
      const blocked = {
        ...decision,
        fallbackOnFailure: false,
        mode: 'blocked' as const,
        budgetStatus: budget,
        alerts,
        reasoning: `${decision.reasoning} | Blocked by ${budget.reason}`,
      };
      this.pushAlert('critical', 'budget.blocked', `Decision blocked by ${budget.reason}`, budget.violatedWindow);
      return blocked;
    }

    let candidate = this.downgradeModel(decision.selectedModel);

    while (candidate !== decision.selectedModel) {
      const adjustedTokens = task
        ? this.estimateOptimizedTokenUsage(task, candidate, ruleResults)
        : decision.estimatedTokens;
      const candidateCost = this.calculateCost(candidate, adjustedTokens);
      const candidateBudget = this.checkBudget(candidateCost, task);

      if (candidateBudget.allowed) {
        this.pushAlert('warning', 'budget.downgrade', `Downgraded to ${candidate} because ${budget.reason}`, budget.violatedWindow);
        return {
          ...decision,
          selectedModel: candidate,
          estimatedTokens: adjustedTokens,
          estimatedCost: candidateCost,
          fallbackOnFailure: this.shouldAllowFallback(candidate),
          mode: decision.overrideApplied ? 'overridden' : 'downgraded',
          budgetStatus: candidateBudget,
          alerts: this.buildAlertsForTask(task),
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

    this.pushAlert('critical', 'budget.no_fallback', `No affordable fallback for ${decision.selectedModel}`, budget.violatedWindow);
    return {
      ...decision,
      fallbackOnFailure: false,
      mode: 'blocked',
      budgetStatus: budget,
      alerts: this.buildAlertsForTask(task),
      reasoning: `${decision.reasoning} | WARNING: ${budget.reason}`,
    };
  }

  /**
   * Allocate budget for a task
   */
  allocateBudget(taskType: TaskType, taskId?: string, requestedCost?: number): BudgetAllocation {
    const baseEstimate = requestedCost ?? this.getBaseCostEstimate(taskType);
    const status = this.checkBudget(baseEstimate);
    const remaining = this.getRemainingBudget();
    const allocation = status.allowed ? Math.min(baseEstimate, remaining.perTask) : 0;

    if (taskId && allocation > 0) {
      this.taskBudgets.set(taskId, allocation);
    }

    return {
      allocated: allocation,
      maxAllowed: remaining.perTask,
      taskType,
      approved: status.allowed,
      reason: status.reason,
      window: status.violatedWindow,
    };
  }

  /**
   * Refund a prior allocation.
   */
  refundBudget(taskId: string): boolean {
    return this.taskBudgets.delete(taskId);
  }

  /**
   * Get remaining budget across all tiers
   */
  getRemainingBudget(): BudgetSnapshot {
    this.resetBudgetsIfNeeded();

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
      perWeek: Math.max(
        0,
        this.config.policy.costLimits.perWeek - this.costTracker.weeklyTotal
      ),
      perMonth: Math.max(
        0,
        this.config.policy.costLimits.perMonth - this.costTracker.monthlyTotal
      ),
    };
  }

  /**
   * Register a custom policy rule
   */
  addRule(rule: PolicyRule): void {
    this.rules = this.rules.filter((entry) => entry.name !== rule.name);
    this.rules.push(rule);
    this.rules.sort((a, b) => b.priority - a.priority);
    this.clearCache();
  }

  /**
   * Remove a policy rule by name.
   */
  removeRule(name: string): boolean {
    const before = this.rules.length;
    this.rules = this.rules.filter((rule) => rule.name !== name);
    if (this.rules.length !== before) {
      this.clearCache();
      return true;
    }
    return false;
  }

  /**
   * Update policy config dynamically.
   */
  updatePolicy(update: PolicyUpdate): void {
    const merged = this.mergeConfig({
      ...this.config,
      ...update,
      policy: {
        ...this.config.policy,
        ...update.policy,
        complexityThresholds: {
          ...this.config.policy.complexityThresholds,
          ...update.policy?.complexityThresholds,
        },
        costLimits: {
          ...this.config.policy.costLimits,
          ...update.policy?.costLimits,
        },
      },
      warningThresholds: {
        ...this.config.warningThresholds,
        ...update.warningThresholds,
      },
      optimization: {
        ...this.config.optimization,
        ...update.optimization,
      },
    });

    this.validatePolicyConfig(merged);
    this.config = merged;
    this.refreshAlerts();
    this.clearCache();
  }

  /**
   * Return a copy of the current config.
   */
  getConfig(): PolicyConfig {
    return JSON.parse(JSON.stringify(this.config)) as PolicyConfig;
  }

  /**
   * Validate a candidate policy config.
   */
  validatePolicyConfig(config: PolicyConfig): void {
    const { complexityThresholds, costLimits, escalationChain } = config.policy;
    if (
      complexityThresholds.low <= 0 ||
      complexityThresholds.medium <= complexityThresholds.low ||
      complexityThresholds.high <= complexityThresholds.medium
    ) {
      throw new Error('Invalid complexity thresholds');
    }

    const limitValues = Object.values(costLimits);
    if (limitValues.some((value) => value <= 0)) {
      throw new Error('Cost limits must be positive');
    }
    if (
      !(costLimits.perTask <= costLimits.perSession &&
        costLimits.perSession <= costLimits.perDay &&
        costLimits.perDay <= costLimits.perWeek &&
        costLimits.perWeek <= costLimits.perMonth)
    ) {
      throw new Error('Cost limits must increase from task -> month');
    }

    if (new Set(escalationChain).size !== escalationChain.length || escalationChain.length === 0) {
      throw new Error('Escalation chain must contain unique models');
    }

    for (const model of escalationChain) {
      if (!(model in MODEL_CAPABILITIES)) {
        throw new Error(`Unknown model in escalation chain: ${model}`);
      }
    }

    const thresholdValues = Object.values(config.warningThresholds);
    if (thresholdValues.some((value) => value <= 0 || value >= 1)) {
      throw new Error('Warning thresholds must be between 0 and 1');
    }

    if (config.cacheTtlMs <= 0) {
      throw new Error('cacheTtlMs must be positive');
    }
  }

  /**
   * Return active alerts.
   */
  getAlerts(): PolicyAlert[] {
    this.refreshAlerts();
    return this.alerts.map((alert) => ({ ...alert }));
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
    this.resetBudgetsIfNeeded();

    this.costTracker = {
      sessionId,
      taskCosts: new Map(),
      sessionTotal: 0,
      dailyTotal: this.costTracker.dailyTotal,
      weeklyTotal: this.costTracker.weeklyTotal,
      monthlyTotal: this.costTracker.monthlyTotal,
      lastReset: this.costTracker.lastReset,
      lastDailyReset: this.costTracker.lastDailyReset,
      lastWeeklyReset: this.costTracker.lastWeeklyReset,
      lastMonthlyReset: this.costTracker.lastMonthlyReset,
    };
    this.taskBudgets.clear();
    this.decisionCache.clear();
    this.refreshAlerts();
  }

  private mergeConfig(config: Partial<PolicyConfig>): PolicyConfig {
    return {
      ...DEFAULT_POLICY_CONFIG,
      ...config,
      policy: {
        ...DEFAULT_POLICY_CONFIG.policy,
        ...config.policy,
        complexityThresholds: {
          ...DEFAULT_POLICY_CONFIG.policy.complexityThresholds,
          ...config.policy?.complexityThresholds,
        },
        costLimits: {
          ...DEFAULT_POLICY_CONFIG.policy.costLimits,
          ...config.policy?.costLimits,
        },
        escalationChain:
          config.policy?.escalationChain ?? DEFAULT_POLICY_CONFIG.policy.escalationChain,
      },
      warningThresholds: {
        ...DEFAULT_POLICY_CONFIG.warningThresholds,
        ...config.warningThresholds,
      },
      optimization: {
        ...DEFAULT_POLICY_CONFIG.optimization,
        ...config.optimization,
      },
    };
  }

  private initializeCostTracker(): CostTracker {
    const now = Date.now();
    return {
      sessionId: `session_${now}`,
      taskCosts: new Map(),
      sessionTotal: 0,
      dailyTotal: 0,
      weeklyTotal: 0,
      monthlyTotal: 0,
      lastReset: now,
      lastDailyReset: now,
      lastWeeklyReset: now,
      lastMonthlyReset: now,
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
      task.batchable ? 'batchable' : 'single',
      String(task.batchSize ?? 1),
      task.overrideModel ?? 'no_override',
    ].join(':');
  }

  private isCacheValid(entry: DecisionCacheEntry, task: TaskContext): boolean {
    if (Date.now() - entry.createdAt > this.config.cacheTtlMs) {
      return false;
    }

    if (!task.preferCached && (task.estimatedTokens ?? 0) < this.config.optimization.cacheReuseThresholdTokens) {
      return false;
    }

    const status = this.checkBudget(entry.decision.estimatedCost, task);
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
      condition: (task) => (task.files?.length ?? 0) > 3 || (task.batchSize ?? 0) >= this.config.optimization.batchMinItems,
      action: () => ({ modelPreference: ['qwen', 'deepseek'], optimizations: ['batching'] }),
    });

    this.addRule({
      name: 'failure_escalation',
      priority: 85,
      condition: (task) => (task.failureCount ?? 0) >= 2,
      action: () => ({ modelPreference: ['deepseek', 'gpt54'] }),
    });

    this.addRule({
      name: 'urgent_tasks_prefer_accuracy',
      priority: 70,
      condition: (task) => task.urgency === 'critical',
      action: () => ({ modelPreference: ['gpt54', 'deepseek'] }),
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

    if (task.urgency === 'critical') {
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
    if (task.overrideModel) {
      if (!this.canModelHandleTask(task.overrideModel, task)) {
        throw new Error(`Override model ${task.overrideModel} cannot handle task`);
      }
      return task.overrideModel;
    }

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

    const pressure = this.getBudgetPressure();
    const underBudgetPressure =
      pressure.session >= this.config.warningThresholds.session ||
      pressure.day >= this.config.warningThresholds.daily ||
      pressure.week >= this.config.warningThresholds.weekly ||
      pressure.month >= this.config.warningThresholds.monthly;

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
    if ((task.batchSize ?? 1) > 1 && !capabilities.supportsBatching) {
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

  private estimateOptimizedTokenUsage(
    task: TaskContext,
    model: ModelTier,
    ruleResults: RuleResult[]
  ): number {
    let tokens = this.estimateTokenUsage(task, model);

    if (this.shouldCompressContext(task)) {
      tokens = Math.max(1, Math.ceil(tokens * this.config.optimization.compressionRatio));
    }

    if (this.shouldBatch(task, model, ruleResults)) {
      const size = Math.max(1, task.batchSize ?? 1);
      const batchingReduction = 1 - Math.min(0.4, 0.08 * (size - 1));
      tokens = Math.max(1, Math.ceil(tokens * batchingReduction));
    }

    if (this.shouldSuggestEarlyTermination(task)) {
      tokens = Math.max(
        1,
        Math.ceil(tokens * (1 - this.config.optimization.earlyTerminationTokenRatio))
      );
    }

    return tokens;
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
    const budgetStatus = this.checkBudget(this.calculateCost(model, estimatedTokens), task);
    const optimizations = this.collectOptimizations(task, model, ruleResults);
    const overrideApplied = Boolean(task.overrideModel);

    return {
      taskId: task.taskId,
      selectedModel: model,
      reasoning: this.buildReasoning(complexity, ruleResults, model),
      estimatedCost: this.calculateCost(model, estimatedTokens),
      estimatedTokens,
      fallbackOnFailure: this.shouldAllowFallback(model),
      mode: overrideApplied ? 'overridden' : ruleResults.some((rule) => rule.action.forceModel) ? 'forced' : 'normal',
      appliedRules: ruleResults.map((rule) => rule.ruleName),
      appliedOptimizations: optimizations,
      alerts: this.buildAlertsForTask(task),
      budgetStatus,
      overrideApplied,
      cacheHit: false,
      batched: optimizations.includes('batching'),
      earlyTerminationSuggested: optimizations.includes('early_termination'),
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

  private applyCostDelta(cost: number): void {
    this.costTracker.sessionTotal += cost;
    this.costTracker.dailyTotal += cost;
    this.costTracker.weeklyTotal += cost;
    this.costTracker.monthlyTotal += cost;
  }

  private buildBreakdown(): CostReport['breakdown'] {
    const byTaskType: CostReport['breakdown']['byTaskType'] = {};
    const bySession: CostReport['breakdown']['bySession'] = {};

    for (const entry of this.costHistory) {
      if (!byTaskType[entry.taskType]) {
        byTaskType[entry.taskType] = { count: 0, cost: 0, tokens: 0 };
      }
      byTaskType[entry.taskType].count += 1;
      byTaskType[entry.taskType].cost += entry.costUsd;
      byTaskType[entry.taskType].tokens += entry.inputTokens + entry.outputTokens;

      if (!bySession[entry.sessionId]) {
        bySession[entry.sessionId] = { count: 0, cost: 0, tokens: 0 };
      }
      bySession[entry.sessionId].count += 1;
      bySession[entry.sessionId].cost += entry.costUsd;
      bySession[entry.sessionId].tokens += entry.inputTokens + entry.outputTokens;
    }

    return { byTaskType, bySession };
  }

  private buildTrends(): CostReport['trends'] {
    return {
      daily: this.aggregateTrend('day'),
      weekly: this.aggregateTrend('week'),
      monthly: this.aggregateTrend('month'),
    };
  }

  private aggregateTrend(window: 'day' | 'week' | 'month'): UsageTrendPoint[] {
    const grouped = new Map<string, UsageTrendPoint>();

    for (const entry of this.costHistory) {
      const date = new Date(entry.timestamp);
      const period =
        window === 'day'
          ? date.toISOString().slice(0, 10)
          : window === 'week'
            ? this.getWeekKey(date)
            : `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;

      const current = grouped.get(period) ?? { period, cost: 0, tokens: 0, tasks: 0 };
      current.cost += entry.costUsd;
      current.tokens += entry.inputTokens + entry.outputTokens;
      current.tasks += 1;
      grouped.set(period, current);
    }

    return Array.from(grouped.values()).sort((a, b) => a.period.localeCompare(b.period));
  }

  private buildDashboard(
    byModel: Record<ModelTier, { count: number; cost: number; tokens: number }>
  ): UsageDashboard {
    const totalTokens = this.costHistory.reduce(
      (sum, entry) => sum + entry.inputTokens + entry.outputTokens,
      0
    );

    const budgetUtilization = this.getBudgetPressure();
    const topModels = Object.entries(byModel)
      .map(([model, stats]) => ({ model: model as ModelTier, cost: stats.cost, tasks: stats.count, tokens: stats.tokens }))
      .sort((a, b) => b.cost - a.cost);

    return {
      totals: {
        sessionCost: this.costTracker.sessionTotal,
        dailyCost: this.costTracker.dailyTotal,
        weeklyCost: this.costTracker.weeklyTotal,
        monthlyCost: this.costTracker.monthlyTotal,
        totalTasks: this.costHistory.length,
        totalTokens,
      },
      burnRates: {
        daily: this.computeBurnRate('day'),
        weekly: this.computeBurnRate('week'),
        monthly: this.computeBurnRate('month'),
      },
      budgetUtilization,
      topModels,
      alerts: this.getAlerts(),
    };
  }

  private forecastUsage(): CostReport['forecast'] {
    return {
      day: this.computeBurnRate('day'),
      week: this.computeBurnRate('week') * 7,
      month: this.computeBurnRate('month') * 30,
    };
  }

  private computeBurnRate(window: 'day' | 'week' | 'month'): number {
    if (this.costHistory.length === 0) {
      return 0;
    }

    const now = Date.now();
    const msWindow =
      window === 'day'
        ? 24 * 60 * 60 * 1000
        : window === 'week'
          ? 7 * 24 * 60 * 60 * 1000
          : 30 * 24 * 60 * 60 * 1000;
    const relevant = this.costHistory.filter((entry) => now - entry.timestamp <= msWindow);
    if (relevant.length === 0) {
      return 0;
    }

    const earliest = Math.min(...relevant.map((entry) => entry.timestamp));
    const days = Math.max(1 / 24, (now - earliest) / (24 * 60 * 60 * 1000));
    const total = relevant.reduce((sum, entry) => sum + entry.costUsd, 0);
    return total / days;
  }

  private toCsv(): string {
    const rows = [
      ['taskId', 'sessionId', 'taskType', 'model', 'inputTokens', 'outputTokens', 'costUsd', 'latencyMs', 'timestamp'].join(','),
      ...this.costHistory.map((entry) =>
        [
          entry.taskId,
          entry.sessionId,
          entry.taskType,
          entry.model,
          String(entry.inputTokens),
          String(entry.outputTokens),
          entry.costUsd.toFixed(6),
          String(entry.latencyMs),
          String(entry.timestamp),
        ].join(',')
      ),
    ];

    return rows.join('\n');
  }

  private buildAlertsForTask(task?: TaskContext): PolicyAlert[] {
    this.refreshAlerts();
    const alerts = [...this.alerts];

    if (task?.overrideModel) {
      alerts.push({
        severity: 'info',
        code: 'policy.override',
        message: `Manual override requested: ${task.overrideModel}`,
        createdAt: Date.now(),
      });
    }

    return alerts;
  }

  private refreshAlerts(): void {
    const next: PolicyAlert[] = [];
    const pressure = this.getBudgetPressure();

    if (pressure.session >= this.config.warningThresholds.session) {
      next.push({
        severity: pressure.session >= 0.95 ? 'critical' : 'warning',
        code: 'budget.session_threshold',
        message: `Session budget at ${(pressure.session * 100).toFixed(1)}%`,
        window: 'session',
        createdAt: Date.now(),
      });
    }
    if (pressure.day >= this.config.warningThresholds.daily) {
      next.push({
        severity: pressure.day >= 0.95 ? 'critical' : 'warning',
        code: 'budget.daily_threshold',
        message: `Daily budget at ${(pressure.day * 100).toFixed(1)}%`,
        window: 'day',
        createdAt: Date.now(),
      });
    }
    if (pressure.week >= this.config.warningThresholds.weekly) {
      next.push({
        severity: pressure.week >= 0.95 ? 'critical' : 'warning',
        code: 'budget.weekly_threshold',
        message: `Weekly budget at ${(pressure.week * 100).toFixed(1)}%`,
        window: 'week',
        createdAt: Date.now(),
      });
    }
    if (pressure.month >= this.config.warningThresholds.monthly) {
      next.push({
        severity: pressure.month >= 0.95 ? 'critical' : 'warning',
        code: 'budget.monthly_threshold',
        message: `Monthly budget at ${(pressure.month * 100).toFixed(1)}%`,
        window: 'month',
        createdAt: Date.now(),
      });
    }

    this.alerts = this.mergeAlertLists(this.alerts.filter((alert) => alert.code.startsWith('budget.') === false), next);
  }

  private pushAlert(
    severity: PolicyAlert['severity'],
    code: string,
    message: string,
    window?: BudgetWindow
  ): void {
    this.alerts = this.mergeAlertLists(this.alerts, [
      {
        severity,
        code,
        message,
        window,
        createdAt: Date.now(),
      },
    ]);
  }

  private mergeAlertLists(existing: PolicyAlert[], incoming: PolicyAlert[]): PolicyAlert[] {
    const merged = new Map<string, PolicyAlert>();
    for (const alert of [...existing, ...incoming]) {
      merged.set(`${alert.code}:${alert.window ?? 'none'}`, alert);
    }
    return Array.from(merged.values()).sort((a, b) => a.createdAt - b.createdAt);
  }

  private getBudgetPressure(): { session: number; day: number; week: number; month: number } {
    return {
      session: this.safeRatio(this.costTracker.sessionTotal, this.config.policy.costLimits.perSession),
      day: this.safeRatio(this.costTracker.dailyTotal, this.config.policy.costLimits.perDay),
      week: this.safeRatio(this.costTracker.weeklyTotal, this.config.policy.costLimits.perWeek),
      month: this.safeRatio(this.costTracker.monthlyTotal, this.config.policy.costLimits.perMonth),
    };
  }

  private safeRatio(value: number, limit: number): number {
    return limit <= 0 ? 0 : value / limit;
  }

  private collectOptimizations(
    task: TaskContext,
    model: ModelTier,
    ruleResults: RuleResult[]
  ): OptimizationAction[] {
    const optimizations = new Set<OptimizationAction>();
    for (const rule of ruleResults) {
      for (const optimization of rule.action.optimizations ?? []) {
        optimizations.add(optimization);
      }
    }

    if (this.shouldCompressContext(task)) {
      optimizations.add('compressed_context');
    }
    if (this.shouldBatch(task, model, ruleResults)) {
      optimizations.add('batching');
    }
    if (this.shouldSuggestEarlyTermination(task)) {
      optimizations.add('early_termination');
    }

    return Array.from(optimizations);
  }

  private shouldCompressContext(task: TaskContext): boolean {
    return (task.estimatedTokens ?? 0) > this.config.policy.complexityThresholds.medium;
  }

  private shouldBatch(task: TaskContext, model: ModelTier, ruleResults: RuleResult[]): boolean {
    if (!MODEL_CAPABILITIES[model].supportsBatching) {
      return false;
    }

    if (task.batchable && (task.batchSize ?? 0) >= this.config.optimization.batchMinItems) {
      return true;
    }

    return ruleResults.some((result) => (result.action.optimizations ?? []).includes('batching'));
  }

  private shouldSuggestEarlyTermination(task: TaskContext): boolean {
    return task.taskType === 'simple_edit' || (task.estimatedTokens ?? 0) <= this.config.policy.complexityThresholds.low;
  }

  private addOptimization(
    optimizations: OptimizationAction[] | undefined,
    optimization: OptimizationAction
  ): OptimizationAction[] {
    return Array.from(new Set([...(optimizations ?? []), optimization]));
  }

  private getEffectiveLimits(task?: TaskContext): PolicyConfig['policy']['costLimits'] {
    const perTask = Math.min(
      this.config.policy.costLimits.perTask,
      task?.maxCostUsd ?? this.config.policy.costLimits.perTask,
      task && this.taskBudgets.has(task.taskId)
        ? this.taskBudgets.get(task.taskId) ?? this.config.policy.costLimits.perTask
        : this.config.policy.costLimits.perTask
    );

    return {
      ...this.config.policy.costLimits,
      perTask,
    };
  }

  private removeHistory(taskId: string): void {
    this.costHistory = this.costHistory.filter((entry) => entry.taskId !== taskId);
  }

  private resetBudgetsIfNeeded(): void {
    const now = Date.now();
    if (!this.isSameUtcDay(this.costTracker.lastDailyReset, now)) {
      this.costTracker.dailyTotal = 0;
      this.costTracker.lastDailyReset = now;
    }
    if (!this.isSameUtcWeek(this.costTracker.lastWeeklyReset, now)) {
      this.costTracker.weeklyTotal = 0;
      this.costTracker.lastWeeklyReset = now;
    }
    if (!this.isSameUtcMonth(this.costTracker.lastMonthlyReset, now)) {
      this.costTracker.monthlyTotal = 0;
      this.costTracker.lastMonthlyReset = now;
    }
    this.costTracker.lastReset = now;
    this.refreshAlerts();
  }

  private isSameUtcDay(a: number, b: number): boolean {
    return new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
  }

  private isSameUtcMonth(a: number, b: number): boolean {
    const da = new Date(a);
    const db = new Date(b);
    return da.getUTCFullYear() === db.getUTCFullYear() && da.getUTCMonth() === db.getUTCMonth();
  }

  private isSameUtcWeek(a: number, b: number): boolean {
    return this.getWeekKey(new Date(a)) === this.getWeekKey(new Date(b));
  }

  private getWeekKey(date: Date): string {
    const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    const day = utc.getUTCDay() || 7;
    utc.setUTCDate(utc.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
    const weekNo = Math.ceil((((utc.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
    return `${utc.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
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

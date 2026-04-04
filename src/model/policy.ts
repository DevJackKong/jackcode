/**
 * Thread 12: Model Policy & Cost Control
 * Central policy engine for model selection, routing rules, and cost management
 */

import type {
  ModelPolicy,
  RoutingDecision,
  CostTracker,
  TaskCost,
  BudgetStatus,
  PolicyRule,
  RuleResult,
  TaskContext,
  ModelTier,
  TokenUsage,
  CostReport,
  BudgetAllocation,
  BudgetSnapshot,
  TaskType,
  ComplexityScore,
  PolicyConfig,
} from './types/policy.js';

import { DEFAULT_POLICY_CONFIG, MODEL_PRICING } from './types/policy.js';

/**
 * Model Policy Engine
 * Determines optimal model selection based on task characteristics and cost constraints
 */
export class ModelPolicyEngine {
  private config: PolicyConfig;
  private costTracker: CostTracker;
  private decisionCache: Map<string, RoutingDecision> = new Map();
  private rules: PolicyRule[] = [];

  constructor(config: Partial<PolicyConfig> = {}) {
    this.config = { ...DEFAULT_POLICY_CONFIG, ...config };
    this.costTracker = this.initializeCostTracker();
    this.registerDefaultRules();
  }

  /**
   * Main entry: select optimal model for a task
   */
  selectModel(task: TaskContext): RoutingDecision {
    const cacheKey = this.generateTaskSignature(task);
    
    // Check cache first
    const cached = this.decisionCache.get(cacheKey);
    if (cached && this.isCacheValid(cached)) {
      return { ...cached, reasoning: `${cached.reasoning} (cached)` };
    }

    // Evaluate policy rules
    const ruleResults = this.evaluateRules(task);
    
    // Score complexity
    const complexity = this.assessComplexity(task);
    
    // Select model tier
    const selectedModel = this.pickModelTier(complexity, ruleResults);
    
    // Estimate costs
    const estimatedTokens = this.estimateTokenUsage(task, selectedModel);
    const estimatedCost = this.calculateCost(selectedModel, estimatedTokens);
    
    // Build decision
    const decision: RoutingDecision = {
      taskId: task.taskId,
      selectedModel,
      reasoning: this.buildReasoning(complexity, ruleResults, selectedModel),
      estimatedCost,
      estimatedTokens,
      fallbackOnFailure: this.shouldAllowFallback(selectedModel),
    };

    // Enforce budget constraints
    const enforced = this.enforceLimits(decision);
    
    // Cache and return
    if (enforced.selectedModel === selectedModel) {
      this.decisionCache.set(cacheKey, enforced);
    }
    
    return enforced;
  }

  /**
   * Check if a cost is within budget
   */
  checkBudget(cost: number): BudgetStatus {
    const remaining = this.getRemainingBudget();
    
    if (cost > remaining.perTask) {
      return { allowed: false, reason: 'per_task_limit_exceeded' };
    }
    if (this.costTracker.sessionTotal + cost > remaining.perSession) {
      return { allowed: false, reason: 'session_limit_exceeded' };
    }
    if (this.costTracker.dailyTotal + cost > remaining.perDay) {
      return { allowed: false, reason: 'daily_limit_exceeded' };
    }
    
    return { allowed: true, reason: 'within_budget' };
  }

  /**
   * Track actual token usage and cost
   */
  trackUsage(taskId: string, usage: TokenUsage): TaskCost {
    const taskCost: TaskCost = {
      model: usage.model,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      costUsd: this.calculateActualCost(usage),
      latencyMs: usage.latencyMs,
    };

    this.costTracker.taskCosts.set(taskId, taskCost);
    this.costTracker.sessionTotal += taskCost.costUsd;
    this.costTracker.dailyTotal += taskCost.costUsd;

    return taskCost;
  }

  /**
   * Generate cost report for current session
   */
  getCostReport(): CostReport {
    const tasks = Array.from(this.costTracker.taskCosts.values());
    const byModel = this.aggregateByModel(tasks);
    
    return {
      sessionId: this.costTracker.sessionId,
      summary: {
        totalTasks: tasks.length,
        totalCost: this.costTracker.sessionTotal,
        totalTokens: tasks.reduce((sum, t) => sum + t.inputTokens + t.outputTokens, 0),
        averageLatency: tasks.length > 0 
          ? tasks.reduce((sum, t) => sum + t.latencyMs, 0) / tasks.length 
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
  enforceLimits(decision: RoutingDecision): RoutingDecision {
    const budget = this.checkBudget(decision.estimatedCost);
    
    if (budget.allowed) {
      return decision;
    }

    // Downgrade model if over budget
    const downgraded = this.downgradeModel(decision.selectedModel);
    if (downgraded !== decision.selectedModel) {
      const newCost = this.estimateCostForModel(downgraded, decision.estimatedTokens);
      
      return {
        ...decision,
        selectedModel: downgraded,
        estimatedCost: newCost,
        reasoning: `${decision.reasoning} | Downgraded due to ${budget.reason}`,
      };
    }

    // Cannot downgrade further - return with warning
    return {
      ...decision,
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
    return {
      perTask: this.config.policy.costLimits.perTask,
      perSession: Math.max(0, this.config.policy.costLimits.perSession - this.costTracker.sessionTotal),
      perDay: Math.max(0, this.config.policy.costLimits.perDay - this.costTracker.dailyTotal),
    };
  }

  /**
   * Register a custom policy rule
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    // Sort by priority (higher first)
    this.rules.sort((a, b) => (b.priority || 0) - (a.priority || 0));
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
    this.costTracker = {
      sessionId,
      taskCosts: new Map(),
      sessionTotal: 0,
      dailyTotal: this.costTracker.dailyTotal,
      lastReset: Date.now(),
    };
    this.decisionCache.clear();
  }

  // ==================== Private Methods ====================

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
    const key = `${task.taskType}:${task.files?.join(',') || ''}:${task.intent?.slice(0, 50) || ''}`;
    return key;
  }

  private isCacheValid(decision: RoutingDecision): boolean {
    // Cache invalid if budget constraints changed
    const status = this.checkBudget(decision.estimatedCost);
    return status.allowed;
  }

  private registerDefaultRules(): void {
    // Rule 1: Critical path - build/test failures prefer cheaper models first
    this.addRule({
      name: 'critical_path_prefer_cheap',
      priority: 100,
      condition: (task) => task.taskType === 'build_fix' || task.taskType === 'test_fix',
      action: () => ({ modelPreference: ['qwen', 'deepseek', 'gpt54'] }),
    });

    // Rule 2: Complex reasoning tasks need DeepSeek or GPT-5.4
    this.addRule({
      name: 'complex_tasks_require_reasoning',
      priority: 90,
      condition: (task) => task.complexity === 'high' || task.requiresReasoning === true,
      action: () => ({ modelPreference: ['deepseek', 'gpt54'] }),
    });

    // Rule 3: Final verification always uses GPT-5.4
    this.addRule({
      name: 'verification_requires_gpt54',
      priority: 95,
      condition: (task) => task.taskType === 'final_verification',
      action: () => ({ modelPreference: ['gpt54'], forceModel: true }),
    });

    // Rule 4: Batch operations prefer Qwen
    this.addRule({
      name: 'batch_prefer_qwen',
      priority: 80,
      condition: (task) => (task.files?.length || 0) > 3,
      action: () => ({ modelPreference: ['qwen', 'deepseek'] }),
    });
  }

  private evaluateRules(task: TaskContext): RuleResult[] {
    return this.rules
      .filter((rule) => rule.condition(task))
      .map((rule) => ({
        ruleName: rule.name,
        priority: rule.priority || 0,
        action: rule.action(task),
      }));
  }

  private assessComplexity(task: TaskContext): ComplexityScore {
    let score = 0;
    
    // Factor 1: Number of files
    const fileCount = task.files?.length || 0;
    if (fileCount <= 1) score += 1;
    else if (fileCount <= 3) score += 2;
    else score += 3;
    
    // Factor 2: Context size estimate
    const contextSize = task.estimatedTokens || 0;
    if (contextSize < 1000) score += 1;
    else if (contextSize < 10000) score += 2;
    else score += 3;
    
    // Factor 3: Task type
    switch (task.taskType) {
      case 'simple_edit':
        score += 1;
        break;
      case 'multi_file_change':
        score += 2;
        break;
      case 'refactor':
      case 'debug':
        score += 3;
        break;
      default:
        score += 2;
    }
    
    // Normalize to low/medium/high
    if (score <= 4) return 'low';
    if (score <= 7) return 'medium';
    return 'high';
  }

  private pickModelTier(complexity: ComplexityScore, rules: RuleResult[]): ModelTier {
    // Check if any rule forces a specific model
    const forcedRule = rules.find((r) => r.action.forceModel);
    if (forcedRule) {
      const preferred = forcedRule.action.modelPreference[0];
      if (preferred) return preferred;
    }
    
    // Merge rule preferences
    const preferences = rules.flatMap((r) => r.action.modelPreference);
    
    // If rules specify preferences, use highest priority valid one
    for (const model of preferences) {
      if (this.isModelAvailable(model)) {
        return model;
      }
    }
    
    // Default: complexity-based selection
    switch (complexity) {
      case 'low':
        return 'qwen';
      case 'medium':
        return this.costTracker.sessionTotal > this.config.policy.costLimits.perSession * 0.7 ? 'qwen' : 'deepseek';
      case 'high':
        return this.costTracker.sessionTotal > this.config.policy.costLimits.perSession * 0.8 ? 'deepseek' : 'gpt54';
      default:
        return this.config.policy.defaultModel;
    }
  }

  private isModelAvailable(model: ModelTier): boolean {
    // TODO: Check model health/availability
    return true;
  }

  private estimateTokenUsage(task: TaskContext, model: ModelTier): number {
    const baseTokens = task.estimatedTokens || 2000;
    
    // Different models have different efficiency
    switch (model) {
      case 'qwen':
        return Math.ceil(baseTokens * 1.0);
      case 'deepseek':
        return Math.ceil(baseTokens * 1.1); // Slightly more verbose
      case 'gpt54':
        return Math.ceil(baseTokens * 1.0);
      default:
        return baseTokens;
    }
  }

  private calculateCost(model: ModelTier, tokens: number): number {
    const pricing = MODEL_PRICING[model];
    // Assume 3:1 input:output ratio for estimation
    const inputTokens = tokens * 0.75;
    const outputTokens = tokens * 0.25;
    return (inputTokens / 1000) * pricing.input + (outputTokens / 1000) * pricing.output;
  }

  private calculateActualCost(usage: TokenUsage): number {
    const pricing = MODEL_PRICING[usage.model];
    return (usage.inputTokens / 1000) * pricing.input + (usage.outputTokens / 1000) * pricing.output;
  }

  private buildReasoning(complexity: ComplexityScore, rules: RuleResult[], model: ModelTier): string {
    const parts: string[] = [];
    parts.push(`Complexity: ${complexity}`);
    if (rules.length > 0) {
      parts.push(`Rules: ${rules.map((r) => r.ruleName).join(', ')}`);
    }
    parts.push(`Selected: ${model}`);
    return parts.join(' | ');
  }

  private shouldAllowFallback(model: ModelTier): boolean {
    return model !== 'gpt54'; // GPT-5.4 is final tier
  }

  private downgradeModel(model: ModelTier): ModelTier {
    const chain = this.config.policy.escalationChain;
    const index = chain.indexOf(model);
    if (index > 0) {
      return chain[index - 1];
    }
    return model; // Cannot downgrade further
  }

  private estimateCostForModel(model: ModelTier, tokens: number): number {
    return this.calculateCost(model, tokens);
  }

  private getBaseCostEstimate(taskType: TaskType): number {
    switch (taskType) {
      case 'simple_edit':
        return 0.005;
      case 'multi_file_change':
        return 0.02;
      case 'refactor':
        return 0.05;
      case 'debug':
        return 0.03;
      case 'final_verification':
        return 0.10;
      default:
        return 0.02;
    }
  }

  private aggregateByModel(tasks: TaskCost[]): Record<ModelTier, { count: number; cost: number; tokens: number }> {
    const result: Record<string, { count: number; cost: number; tokens: number }> = {};
    
    for (const task of tasks) {
      if (!result[task.model]) {
        result[task.model] = { count: 0, cost: 0, tokens: 0 };
      }
      result[task.model].count++;
      result[task.model].cost += task.costUsd;
      result[task.model].tokens += task.inputTokens + task.outputTokens;
    }
    
    return result as Record<ModelTier, { count: number; cost: number; tokens: number }>;
  }
}

/**
 * Singleton policy engine instance
 */
export const modelPolicyEngine = new ModelPolicyEngine();

/**
 * Factory for creating custom policy engines
 */
export function createModelPolicyEngine(config?: Partial<PolicyConfig>): ModelPolicyEngine {
  return new ModelPolicyEngine(config);
}
/**
 * Thread 10: DeepSeek Reasoner Router
 * Escalation reasoning engine for failed executions
 */

import type {
  RepairContext,
  ReasoningResult,
  FailureAnalysis,
  RepairStrategy,
  DeepSeekConfig,
  ReasoningHook,
  RepairPlan,
  ConfidenceLevel,
} from '../types/reasoning.js';

/**
 * Default configuration for DeepSeek reasoning
 */
const DEFAULT_CONFIG: DeepSeekConfig = {
  model: 'deepseek-reasoner',
  maxReasoningTokens: 8192,
  temperature: 0.1,  // Low temp for deterministic reasoning
  timeoutMs: 60000,
};

/**
 * DeepSeek Reasoner Router
 * Handles escalation reasoning when execution fails
 */
export class DeepSeekReasonerRouter {
  private config: DeepSeekConfig;
  private reasoningHooks: Map<string, ReasoningHook> = new Map();

  constructor(config: Partial<DeepSeekConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.registerDefaultHooks();
  }

  /**
   * Main entry point: analyze a failure and produce reasoning result
   */
  async analyzeFailure(context: RepairContext): Promise<ReasoningResult> {
    const analysis = await this.performFailureAnalysis(context);
    const strategy = this.generateRepairStrategy(analysis);
    const confidence = this.scoreConfidence(strategy);

    return {
      rootCause: analysis.rootCause,
      strategy,
      confidence,
      reasoningChain: analysis.reasoningChain,
      metadata: {
        model: this.config.model,
        analyzedAt: Date.now(),
        errorCount: context.errors.length,
      },
    };
  }

  /**
   * Deep reasoning on failure context to identify root cause
   */
  private async performFailureAnalysis(
    context: RepairContext
  ): Promise<FailureAnalysis> {
    const errors = context.errors;
    const latestError = errors[errors.length - 1];

    // Categorize the failure type
    const failureType = this.categorizeFailure(latestError?.message || '');

    // Build reasoning chain
    const reasoningChain: string[] = [
      `Received ${errors.length} error(s) from execution`,
      `Latest error type: ${failureType}`,
      `Attempt ${context.attemptNumber} of ${context.maxAttempts}`,
    ];

    // Analyze artifacts if available
    if (context.artifacts.length > 0) {
      reasoningChain.push(
        `Analyzing ${context.artifacts.length} artifact(s) for context`
      );
    }

    // Determine root cause based on failure patterns
    const rootCause = this.inferRootCause(failureType, errors, context.artifacts);
    reasoningChain.push(`Root cause identified: ${rootCause}`);

    return {
      failureType,
      rootCause,
      affectedFiles: this.identifyAffectedFiles(errors, context.artifacts),
      reasoningChain,
      context: {
        errorMessages: errors.map((e) => e.message),
        artifactPaths: context.artifacts.map((a) => a.path),
        compressedContext: context.context?.content || '',
      },
    };
  }

  /**
   * Categorize failure based on error message patterns
   */
  private categorizeFailure(errorMessage: string): FailureAnalysis['failureType'] {
    const msg = errorMessage.toLowerCase();

    if (msg.includes('syntax') || msg.includes('parse') || msg.includes('unexpected token')) {
      return 'syntax_error';
    }
    if (msg.includes('type') || msg.includes('typescript') || msg.includes('typeerror')) {
      return 'type_error';
    }
    if (msg.includes('test') || msg.includes('assert') || msg.includes('expect')) {
      return 'test_failure';
    }
    if (msg.includes('import') || msg.includes('module') || msg.includes('cannot find')) {
      return 'dependency_error';
    }
    if (msg.includes('runtime') || msg.includes('exception') || msg.includes('throw')) {
      return 'runtime_error';
    }
    return 'unknown';
  }

  /**
   * Infer root cause from failure type and context
   */
  private inferRootCause(
    failureType: FailureAnalysis['failureType'],
    errors: RepairContext['errors'],
    artifacts: RepairContext['artifacts']
  ): string {
    switch (failureType) {
      case 'syntax_error':
        return 'Code changes introduced syntax error, likely missing delimiter or incorrect syntax structure';
      case 'type_error':
        return 'Type system violation - incompatible types or missing type annotations';
      case 'test_failure':
        return 'Implementation does not satisfy test expectations';
      case 'dependency_error':
        return 'Missing or incorrect import/module reference';
      case 'runtime_error':
        return 'Runtime exception - possible null reference or logic error';
      default:
        return 'Unknown failure - requires manual investigation';
    }
  }

  /**
   * Identify files affected by the failure
   */
  private identifyAffectedFiles(
    errors: RepairContext['errors'],
    artifacts: RepairContext['artifacts']
  ): string[] {
    const files = new Set<string>();

    // Extract file paths from error messages
    for (const error of errors) {
      const fileMatch = error.message.match(/([\/.\w-]+\.(ts|js|tsx|jsx|json))/i);
      if (fileMatch) {
        files.add(fileMatch[1]);
      }
    }

    // Include artifact paths
    for (const artifact of artifacts) {
      files.add(artifact.path);
    }

    return Array.from(files);
  }

  /**
   * Generate repair strategy from failure analysis
   */
  generateRepairStrategy(analysis: FailureAnalysis): RepairStrategy {
    const plan = this.createRepairPlan(analysis);

    return {
      plan,
      estimatedEffort: this.estimateEffort(plan),
      risks: this.assessRisks(analysis),
      alternatives: this.suggestAlternatives(analysis),
    };
  }

  /**
   * Create specific repair plan steps
   */
  private createRepairPlan(analysis: FailureAnalysis): RepairPlan {
    const steps: RepairPlan['steps'] = [];

    switch (analysis.failureType) {
      case 'syntax_error':
        steps.push(
          { action: 'locate_syntax_error', target: analysis.affectedFiles[0], description: 'Find exact syntax error location' },
          { action: 'apply_syntax_fix', target: analysis.affectedFiles[0], description: 'Correct syntax structure' }
        );
        break;
      case 'type_error':
        steps.push(
          { action: 'analyze_types', target: analysis.affectedFiles[0], description: 'Analyze type mismatch' },
          { action: 'add_type_annotation', target: analysis.affectedFiles[0], description: 'Add or fix type annotations' }
        );
        break;
      case 'test_failure':
        steps.push(
          { action: 'review_test_expectations', target: 'test', description: 'Understand test requirements' },
          { action: 'fix_implementation', target: analysis.affectedFiles[0], description: 'Update implementation to match expectations' }
        );
        break;
      case 'dependency_error':
        steps.push(
          { action: 'resolve_import', target: analysis.affectedFiles[0], description: 'Fix import statement' },
          { action: 'verify_exports', target: 'dependency', description: 'Verify module exports exist' }
        );
        break;
      default:
        steps.push(
          { action: 'manual_review', target: 'unknown', description: 'Requires human investigation' }
        );
    }

    return {
      steps,
      targetModel: 'deepseek',
      estimatedTokens: this.estimateRepairTokens(steps),
    };
  }

  /**
   * Score confidence in the repair strategy
   */
  scoreConfidence(strategy: RepairStrategy): number {
    let score = 0.5; // Base confidence

    // Adjust based on plan specificity
    const specificSteps = strategy.plan.steps.filter(
      (s) => s.target !== 'unknown' && s.action !== 'manual_review'
    ).length;
    score += specificSteps * 0.1;

    // Penalize high estimated effort
    if (strategy.estimatedEffort === 'high') {
      score -= 0.2;
    }

    // Adjust based on risk level
    if (strategy.risks.includes('breaking_change')) {
      score -= 0.15;
    }

    // Clamp to 0-1 range
    return Math.max(0, Math.min(1, score));
  }

  /**
   * Estimate effort level for a repair plan
   */
  private estimateEffort(plan: RepairPlan): RepairStrategy['estimatedEffort'] {
    const stepCount = plan.steps.length;
    if (stepCount <= 2) return 'low';
    if (stepCount <= 4) return 'medium';
    return 'high';
  }

  /**
   * Assess risks for a given failure analysis
   */
  private assessRisks(analysis: FailureAnalysis): RepairStrategy['risks'] {
    const risks: RepairStrategy['risks'] = [];

    if (analysis.affectedFiles.length > 3) {
      risks.push('wide_impact');
    }
    if (analysis.failureType === 'dependency_error') {
      risks.push('cascading_failure');
    }
    if (analysis.failureType === 'test_failure') {
      risks.push('breaking_change');
    }

    return risks;
  }

  /**
   * Suggest alternative approaches
   */
  private suggestAlternatives(analysis: FailureAnalysis): RepairStrategy['alternatives'] {
    const alternatives: RepairStrategy['alternatives'] = [];

    if (analysis.failureType === 'test_failure') {
      alternatives.push({
        description: 'Revert changes and try different approach',
        confidence: 0.6,
      });
    }

    if (analysis.failureType === 'type_error') {
      alternatives.push({
        description: 'Use type assertion as temporary fix',
        confidence: 0.4,
      });
    }

    return alternatives;
  }

  /**
   * Estimate token count for repair steps
   */
  private estimateRepairTokens(steps: RepairPlan['steps']): number {
    // Rough estimate: 500 tokens per step
    return steps.length * 500;
  }

  /**
   * Get confidence level category
   */
  getConfidenceLevel(score: number): ConfidenceLevel {
    if (score >= 0.8) return 'high';
    if (score >= 0.5) return 'medium';
    return 'low';
  }

  /**
   * Register a custom reasoning hook
   */
  registerHook(name: string, hook: ReasoningHook): void {
    this.reasoningHooks.set(name, hook);
  }

  /**
   * Execute a registered hook
   */
  async executeHook(name: string, context: RepairContext): Promise<ReasoningResult | null> {
    const hook = this.reasoningHooks.get(name);
    if (hook) {
      return await hook(context);
    }
    return null;
  }

  /**
   * Register default reasoning hooks
   */
  private registerDefaultHooks(): void {
    // Default fallback hook
    this.registerHook('default', async (context) => {
      return await this.analyzeFailure(context);
    });

    // Quick fix hook for simple errors
    this.registerHook('quick_fix', async (context) => {
      if (context.errors.length === 1 && context.attemptNumber === 1) {
        // Fast path for single errors on first attempt
        const analysis = await this.performFailureAnalysis(context);
        if (analysis.failureType !== 'unknown') {
          const strategy = this.generateRepairStrategy(analysis);
          const confidence = Math.min(0.9, this.scoreConfidence(strategy) + 0.2);
          return {
            rootCause: analysis.rootCause,
            strategy,
            confidence,
            reasoningChain: [...analysis.reasoningChain, 'Quick fix path taken'],
            metadata: {
              model: this.config.model,
              analyzedAt: Date.now(),
              errorCount: context.errors.length,
            },
          };
        }
      }
      return null;
    });
  }
}

/**
 * Singleton instance for global use
 */
export const deepseekRouter = new DeepSeekReasonerRouter();

export default DeepSeekReasonerRouter;

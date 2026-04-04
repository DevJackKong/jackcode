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
    if (strategy.estimatedEffort === 'high')
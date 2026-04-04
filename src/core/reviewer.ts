/**
 * Thread 11: GPT-5.4 Verifier / Repairer
 * Final verification and quality assurance layer for JackCode
 */

import type {
  ChangeSet,
  CodeLocation,
  GPT54VerifierConfig,
  IssueSeverity,
  MinorIssue,
  RepairResult,
  ReviewContext,
  SafetyReport,
  QualityReport,
  VerificationDecision,
  VerificationDimension,
  VerificationIssue,
  VerificationReport,
  VerificationResult,
  VerifierHook,
  VerifierHookRegistration,
  DEFAULT_VERIFIER_CONFIG,
} from '../types/reviewer.js';
import type { Patch } from '../types/patch.js';

/**
 * GPT-5.4 Verifier / Repairer
 * Ultimate gatekeeper for code quality and correctness
 */
export class GPT54VerifierRepairer {
  private config: GPT54VerifierConfig;
  private hooks: VerifierHookRegistration[] = [];
  private verificationHistory: Map<string, VerificationResult> = new Map();

  constructor(config: Partial<GPT54VerifierConfig> = {}) {
    this.config = { ...DEFAULT_VERIFIER_CONFIG, ...config };
  }

  /**
   * Main entry point: verify a task's changes
   */
  async verify(context: ReviewContext): Promise<VerificationResult> {
    const startTime = Date.now();

    // Run verification pipeline
    const issues: VerificationIssue[] = [];
    const dimensionResults: Record<VerificationDimension, boolean> = {
      intent_match: false,
      code_quality: false,
      type_safety: false,
      test_coverage: false,
      no_regression: false,
      security: false,
    };

    // 1. Intent validation
    const intentResult = await this.validateIntent(context);
    issues.push(...intentResult.issues);
    dimensionResults.intent_match = intentResult.fulfilled;

    // 2. Quality assessment
    const qualityReport = await this.assessQuality(context.changes);
    if (qualityReport.score < 0.8) {
      issues.push(...this.createQualityIssues(context, qualityReport));
    }
    dimensionResults.code_quality = qualityReport.score >= 0.8;

    // 3. Safety validation
    const safetyReport = await this.validateSafety(context);
    if (!safetyReport.noBreakingChanges || !safetyReport.noSecurityIssues) {
      issues.push(...this.createSafetyIssues(context, safetyReport));
    }
    dimensionResults.no_regression = safetyReport.noBreakingChanges;
    dimensionResults.security = safetyReport.noSecurityIssues;
    dimensionResults.type_safety = safetyReport.typeSafe;

    // 4. Test coverage validation
    const testResult = this.validateTestCoverage(context);
    issues.push(...testResult.issues);
    dimensionResults.test_coverage = testResult.adequate;

    // Determine decision based on findings
    const decision = this.makeDecision(dimensionResults, issues);
    const confidence = this.calculateConfidence(dimensionResults, issues);

    // Generate repairs for minor issues if enabled
    let repairs: Patch[] = [];
    if (decision === 'repair' && this.config.enablePolishFixes) {
      const minorIssues = issues.filter(
        (i): i is MinorIssue => i.severity === 'low' || i.severity === 'medium'
      );
      if (minorIssues.length <= this.config.autoRepairThreshold) {
        repairs = await this.applyPolishFixes(minorIssues);
      }
    }

    // Build verification report
    const report: VerificationReport = {
      verifiedAt: Date.now(),
      model: this.config.model,
      quality: qualityReport,
      safety: safetyReport,
      intentFulfilled: dimensionResults.intent_match,
      summary: this.generateSummary(context, decision, issues),
    };

    // Build final result
    const result: VerificationResult = {
      decision,
      issues,
      repairs,
      confidence,
      report,
      metadata: {
        model: this.config.model,
        verifiedAt: Date.now(),
        durationMs: Date.now() - startTime,
        issueCount: issues.length,
      },
    };

    // Store in history
    this.verificationHistory.set(context.taskId, result);

    // Execute registered hooks
    await this.executeHooks(context, result);

    return result;
  }

  /**
   * Validate that changes fulfill original intent
   */
  private async validateIntent(
    context: ReviewContext
  ): Promise<{ fulfilled: boolean; issues: VerificationIssue[] }> {
    const issues: VerificationIssue[] = [];

    // TODO: Integrate with GPT-5.4 API for semantic intent matching
    // For now, scaffold basic validation
    const intentFulfilled = context.changes.length > 0;

    if (!intentFulfilled) {
      issues.push({
        dimension: 'intent_match',
        severity: 'critical',
        description: 'No changes were made to fulfill the task intent',
        location: { filePath: context.taskId },
        suggestion: 'Execute the planned changes to fulfill the intent',
      });
    }

    return { fulfilled: intentFulfilled, issues };
  }

  /**
   * Assess code quality of changes
   */
  async assessQuality(changes: ChangeSet[]): Promise<QualityReport> {
    // TODO: Integrate with GPT-5.4 API for quality analysis
    // Scaffold default quality report
    const dimensionScores: Record<VerificationDimension, number> = {
      intent_match: 1.0,
      code_quality: 0.85,
      type_safety: 1.0,
      test_coverage: 0.9,
      no_regression: 1.0,
      security: 0.95,
    };

    const score =
      Object.values(dimensionScores).reduce((a, b) => a + b, 0) /
      Object.values(dimensionScores).length;

    return {
      score,
      styleCompliant: score >= 0.8,
      patternsConsistent: score >= 0.8,
      documentationAdequate: score >= 0.7,
      dimensionScores,
    };
  }

  /**
   * Validate safety and check for regressions
   */
  async validateSafety(context: ReviewContext): Promise<SafetyReport> {
    // TODO: Integrate with GPT-5.4 API for safety analysis
    // Check test results for failures
    const testFailures = context.testResults.filter((t) => !t.passed);
    const typeErrors = context.artifacts.filter(
      (a) => a.type === 'log' && a.content?.includes('Type error')
    );

    return {
      noBreakingChanges: testFailures.length === 0,
      noSecurityIssues: true, // TODO: Security analysis
      typeSafe: typeErrors.length === 0,
      risks: testFailures.map((t) => `Test failed: ${t.testId}`),
    };
  }

  /**
   * Validate test coverage for changes
   */
  private validateTestCoverage(context: ReviewContext): {
    adequate: boolean;
    issues: VerificationIssue[];
  } {
    const issues: VerificationIssue[] = [];
    const testFailures = context.testResults.filter((t) => !t.passed);

    if (testFailures.length > 0) {
      for (const failure of testFailures) {
        issues.push({
          dimension: 'test_coverage',
          severity: 'high',
          description: `Test failed: ${failure.errorMessage || 'Unknown error'}`,
          location: { filePath: failure.filePath },
          suggestion: 'Fix the failing test or the underlying code issue',
        });
      }
    }

    // Check if changed files have corresponding tests
    const changedFiles = context.changes.map((c) => c.path);
    const testFiles = context.testResults.map((t) => t.filePath);
    const hasTests = changedFiles.some((f) =>
      testFiles.some((t) => t.includes(f.replace('.ts', '.test.ts')))
    );

    if (!hasTests && changedFiles.length > 0) {
      issues.push({
        dimension: 'test_coverage',
        severity: 'medium',
        description: 'No tests found for modified files',
        location: { filePath: changedFiles[0] },
        suggestion: 'Add unit tests for the changed functionality',
      });
    }

    return { adequate: testFailures.length === 0, issues };
  }

  /**
   * Create quality issues from quality report
   */
  private createQualityIssues(
    context: ReviewContext,
    report: QualityReport
  ): VerificationIssue[] {
    const issues: VerificationIssue[] = [];

    if (!report.styleCompliant) {
      issues.push({
        dimension: 'code_quality',
        severity: 'medium',
        description: 'Code style does not match project conventions',
        location: { filePath: context.changes[0]?.path || 'unknown' },
        suggestion: 'Run formatter/linter and fix style issues',
      });
    }

    if (!report.patternsConsistent) {
      issues.push({
        dimension: 'code_quality',
        severity: 'medium',
        description: 'Code patterns inconsistent with existing codebase',
        location: { filePath: context.changes[0]?.path || 'unknown' },
        suggestion: 'Align implementation with existing patterns',
      });
    }

    return issues;
  }

  /**
   * Create safety issues from safety report
   */
  private createSafetyIssues(
    context: ReviewContext,
    report: SafetyReport
  ): VerificationIssue[] {
    const issues: VerificationIssue[] = [];

    if (!report.noBreakingChanges) {
      issues.push({
        dimension: 'no_regression',
        severity: 'critical',
        description: `Potential breaking changes detected: ${report.risks.join(', ')}`,
        location: { filePath: context.changes[0]?.path || 'unknown' },
        suggestion: 'Ensure backward compatibility or mark as breaking change',
      });
    }

    if (!report.noSecurityIssues) {
      issues.push({
        dimension: 'security',
        severity: 'critical',
        description: 'Security anti-pattern detected in changes',
        location: { filePath: context.changes[0]?.path || 'unknown' },
        suggestion: 'Review and fix security concerns',
      });
    }

    if (!report.typeSafe) {
      issues.push({
        dimension: 'type_safety',
        severity: 'high',
        description: 'Type safety violations detected',
        location: { filePath: context.changes[0]?.path || 'unknown' },
        suggestion: 'Fix TypeScript type errors',
      });
    }

    return issues;
  }

  /**
   * Make final decision based on verification results
   */
  private makeDecision(
    dimensionResults: Record<VerificationDimension, boolean>,
    issues: VerificationIssue[]
  ): VerificationDecision {
    // Critical check: intent must be fulfilled
    if (!dimensionResults.intent_match) {
      return 'reject';
    }

    // Critical check: no breaking changes or security issues
    if (!dimensionResults.no_regression || !dimensionResults.security) {
      return 'reject';
    }

    const criticalIssues = issues.filter((i) => i.severity === 'critical');
    const highIssues = issues.filter((i) => i.severity === 'high');

    // Reject on critical issues
    if (criticalIssues.length > 0) {
      return 'reject';
    }

    // Repair if high severity issues or quality below threshold
    if (highIssues.length > 0 || !dimensionResults.code_quality) {
      return 'repair';
    }

    // Approve if all critical dimensions pass
    const allPass = Object.values(dimensionResults).every((v) => v);
    if (allPass) {
      return 'approve';
    }

    // Default to repair for minor issues
    return issues.length > 0 ? 'repair' : 'approve';
  }

  /**
   * Calculate confidence score for decision
   */
  private calculateConfidence(
    dimensionResults: Record<VerificationDimension, boolean>,
    issues: VerificationIssue[]
  ): number {
    const dimensionPassRate =
      Object.values(dimensionResults).filter(Boolean).length /
      Object.values(dimensionResults).length;

    const severityPenalty = issues.reduce((penalty, issue) => {
      switch (issue.severity) {
        case 'critical':
          return penalty + 0.3;
        case 'high':
          return penalty + 0.2;
        case 'medium':
          return penalty + 0.1;
        case 'low':
          return penalty + 0.05;
        default:
          return penalty;
      }
    }, 0);

    return Math.max(0, dimensionPassRate - severityPenalty);
  }

  /**
   * Apply polish fixes for minor issues
   */
  async applyPolishFixes(minorIssues: MinorIssue[]): Promise<Patch[]> {
    const patches: Patch[] = [];

    for (const issue of minorIssues) {
      if (issue.autoFixPatch) {
        patches.push(issue.autoFixPatch);
      }
      // TODO: Generate patches using GPT-5.4 for style/format fixes
    }

    return patches;
  }

  /**
   * Generate human-readable summary
   */
  private generateSummary(
    context: ReviewContext,
    decision: VerificationDecision,
    issues: VerificationIssue[]
  ): string {
    const issueCount = issues.length;
    const criticalCount = issues.filter((i) => i.severity === 'critical').length;
    const highCount = issues.filter((i) => i.severity === 'high').length;

    let summary = `Verification for task ${context.taskId}: `;
    summary += `Decision=${decision.toUpperCase()}, `;
    summary += `${issueCount} issues found `;
    summary += `(${criticalCount} critical, ${highCount} high). `;

    if (decision === 'approve') {
      summary += 'Changes approved for completion.';
    } else if (decision === 'repair') {
      summary += 'Minor repairs required before completion.';
    } else {
      summary += 'Significant issues require escalation to repair state.';
    }

    return summary;
  }

  /**
   * Register a verification hook
   */
  registerHook(registration: VerifierHookRegistration): void {
    this.hooks.push(registration);
    this.hooks.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Execute registered hooks
   */
  private async executeHooks(
    context: ReviewContext,
    result: VerificationResult
  ): Promise<void> {
    for (const registration of this.hooks) {
      try {
        await registration.hook(context);
      } catch (error) {
        console.error(`Hook ${registration.name} failed:`, error);
      }
    }
  }

  /**
   * Get verification result for a task
   */
  getVerificationHistory(taskId: string): VerificationResult | undefined {
    return this.verificationHistory.get(taskId);
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<GPT54VerifierConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): GPT54VerifierConfig {
    return { ...this.config };
  }
}

/** Singleton verifier instance */
export const gpt54Verifier = new GPT54VerifierRepairer();

/** Factory for custom verifier instances */
export function createGPT54Verifier(
  config?: Partial<GPT54VerifierConfig>
): GPT54VerifierRepairer {
  return new GPT54VerifierRepairer(config);
}

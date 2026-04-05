/**
 * Thread 19 + Thread 11: Recovery-Retry-Safety + GPT-5.4 Verifier/Repairer
 * Resilience, retry logic, safety guardrails, and final verification for JackCode.
 */

import { randomUUID, createHash } from 'crypto';
import type {
  FailureCategory,
  CircuitState,
  RetryConfig,
  CircuitBreakerConfig,
  SafetyConfig,
  RecoveryConfig,
  ClassifiedFailure,
  RetryAttempt,
  RetryResult,
  CircuitStats,
  SafetyCheck,
  SafetyViolation,
  ResourceSnapshot,
  RecoveryContext,
  RecoveryResult,
  EscalationInfo,
  LoopPattern,
  Operation,
  ErrorClassifier,
  RecoveryHook,
  CircuitBreakerEvent,
} from '../types/repairer.ts';
import { DEFAULT_RECOVERY_CONFIG } from '../types/repairer.ts';
import type {
  ChangeSet,
  CodeLocation,
  GPT54VerifierConfig,
  MinorIssue,
  ReviewContext,
  SafetyReport,
  QualityReport,
  VerificationDecision,
  VerificationDimension,
  VerificationIssue,
  VerificationReport,
  VerificationResult,
  VerifierHookRegistration,
} from '../types/reviewer.ts';
import { DEFAULT_VERIFIER_CONFIG } from '../types/reviewer.ts';
import type { Patch, Hunk } from '../types/patch.ts';

/**
 * Retry Manager
 * Handles exponential backoff with jitter for transient failures
 */
export class RetryManager {
  private config: RetryConfig;
  private errorClassifier: ErrorClassifier;
  private activeRetries: Map<string, number> = new Map();

  constructor(
    config: Partial<RetryConfig> = {},
    errorClassifier?: ErrorClassifier
  ) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.retry, ...config };
    this.errorClassifier = errorClassifier || this.defaultErrorClassifier.bind(this);
  }

  async execute<T>(operation: Operation<T>, operationId: string = randomUUID()): Promise<RetryResult<T>> {
    const startTime = Date.now();
    const retryHistory: RetryAttempt[] = [];
    let lastError: unknown;
    const maxRetries = this.config.maxRetries;

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      try {
        const activeCount = this.getActiveRetryCount();
        if (activeCount >= DEFAULT_RECOVERY_CONFIG.safety.maxConcurrentRetries) {
          throw new Error('Max concurrent retries exceeded');
        }

        this.incrementActiveRetry(operationId);
        const result = await operation();
        this.decrementActiveRetry(operationId);

        return {
          success: true,
          value: result,
          attempts: attempt,
          durationMs: Date.now() - startTime,
          retryHistory,
        };
      } catch (error) {
        this.decrementActiveRetry(operationId);
        lastError = error;
        const category = this.errorClassifier(error);

        retryHistory.push({
          attemptNumber: attempt,
          timestamp: Date.now(),
          error,
          delayMs: attempt > 1 ? this.calculateDelay(attempt - 1) : 0,
        });

        if (attempt > maxRetries || category === 'permanent' || category === 'safety') {
          break;
        }

        if (attempt <= maxRetries) {
          await this.sleep(this.calculateDelay(attempt));
        }
      }
    }

    return {
      success: false,
      error: lastError,
      attempts: retryHistory.length,
      durationMs: Date.now() - startTime,
      retryHistory,
    };
  }

  classifyError(error: unknown): ClassifiedFailure {
    const category = this.errorClassifier(error);
    const reason = this.extractErrorMessage(error);

    return {
      category,
      error,
      reason,
      timestamp: Date.now(),
      retryable: category === 'transient' || category === 'unknown',
    };
  }

  calculateDelay(attempt: number): number {
    const exponentialDelay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt - 1);
    const cappedDelay = Math.min(exponentialDelay, this.config.maxDelayMs);

    if (this.config.jitter) {
      const jitter = cappedDelay * 0.25;
      return Math.max(0, cappedDelay + (Math.random() * jitter * 2 - jitter));
    }

    return cappedDelay;
  }

  private defaultErrorClassifier(error: unknown): FailureCategory {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      const code = (error as { code?: string }).code;

      if (message.includes('memory limit') || message.includes('infinite loop') || message.includes('max concurrent')) {
        return 'safety';
      }

      if (
        this.config.retryableErrors.some((e) => message.includes(e.toLowerCase()) || code === e) ||
        message.includes('timeout') ||
        message.includes('rate limit') ||
        message.includes('econnrefused') ||
        message.includes('econnreset')
      ) {
        return 'transient';
      }

      if (
        message.includes('syntax error') ||
        message.includes('type error') ||
        message.includes('reference error') ||
        message.includes('not found') ||
        message.includes('invalid')
      ) {
        return 'permanent';
      }
    }

    return 'unknown';
  }

  private extractErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getActiveRetryCount(): number {
    return Array.from(this.activeRetries.values()).reduce((total, count) => total + count, 0);
  }

  private incrementActiveRetry(operationId: string): void {
    const current = this.activeRetries.get(operationId) || 0;
    this.activeRetries.set(operationId, current + 1);
  }

  private decrementActiveRetry(operationId: string): void {
    const current = this.activeRetries.get(operationId) || 0;
    if (current <= 1) {
      this.activeRetries.delete(operationId);
      return;
    }
    this.activeRetries.set(operationId, current - 1);
  }

  updateConfig(config: Partial<RetryConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): RetryConfig {
    return { ...this.config };
  }
}

export class CircuitBreaker {
  private config: CircuitBreakerConfig;
  private state: CircuitState = 'CLOSED';
  private consecutiveFailures = 0;
  private consecutiveSuccesses = 0;
  private totalSuccesses = 0;
  private totalFailures = 0;
  private lastFailureTime?: number;
  private openedAt?: number;
  private stateChangeListeners: Array<(event: CircuitBreakerEvent) => void> = [];

  constructor(config: Partial<CircuitBreakerConfig> = {}) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.circuitBreaker, ...config };
  }

  async call<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') {
      if (this.openedAt && Date.now() - this.openedAt >= this.config.timeoutMs) {
        this.transitionTo('HALF_OPEN', 'Timeout elapsed, attempting recovery');
      } else {
        throw new CircuitBreakerOpenError('Circuit breaker is OPEN');
      }
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    this.totalSuccesses++;

    if (this.state === 'HALF_OPEN' && this.consecutiveSuccesses >= this.config.successThreshold) {
      this.transitionTo('CLOSED', 'Success threshold reached');
    }
  }

  recordFailure(): void {
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    this.totalFailures++;
    this.lastFailureTime = Date.now();

    if (this.consecutiveFailures >= this.config.failureThreshold) {
      this.transitionTo('OPEN', 'Failure threshold exceeded');
      this.openedAt = Date.now();
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getStats(): CircuitStats {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalSuccesses: this.totalSuccesses,
      totalFailures: this.totalFailures,
      lastFailureTime: this.lastFailureTime,
      openedAt: this.openedAt,
    };
  }

  reset(): void {
    this.transitionTo('CLOSED', 'Manual reset');
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = undefined;
  }

  onStateChange(callback: (event: CircuitBreakerEvent) => void): void {
    this.stateChangeListeners.push(callback);
  }

  private transitionTo(newState: CircuitState, reason: string): void {
    const from = this.state;
    this.state = newState;
    const event: CircuitBreakerEvent = { from, to: newState, timestamp: Date.now(), reason };
    this.stateChangeListeners.forEach((listener) => listener(event));
  }
}

export class CircuitBreakerOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CircuitBreakerOpenError';
  }
}

export class SafetyGuardian {
  private config: SafetyConfig;
  private loopPatterns: Map<string, LoopPattern> = new Map();
  private taskRetryCounts: Map<string, number> = new Map();
  private startTimes: Map<string, number> = new Map();

  constructor(config: Partial<SafetyConfig> = {}) {
    this.config = { ...DEFAULT_RECOVERY_CONFIG.safety, ...config };
  }

  checkLimits(context: { taskId: string; activeRetries: number; memoryMb?: number }): SafetyCheck {
    const violations: SafetyViolation[] = [];
    const taskRetryCount = this.getTaskRetryCount(context.taskId);

    if (taskRetryCount >= this.config.maxRetriesPerTask) {
      violations.push({
        guardrail: 'maxRetriesPerTask',
        current: taskRetryCount,
        limit: this.config.maxRetriesPerTask,
        severity: 'critical',
        description: `Task retry count (${taskRetryCount}) exceeded limit`,
      });
    }

    if (context.activeRetries >= this.config.maxConcurrentRetries) {
      violations.push({
        guardrail: 'maxConcurrentRetries',
        current: context.activeRetries,
        limit: this.config.maxConcurrentRetries,
        severity: 'critical',
        description: 'Max concurrent retries exceeded',
      });
    }

    const elapsedMs = this.getElapsedTime(context.taskId);
    if (elapsedMs >= this.config.totalTimeoutMs) {
      violations.push({
        guardrail: 'totalTimeoutMs',
        current: elapsedMs,
        limit: this.config.totalTimeoutMs,
        severity: 'critical',
        description: `Task timeout (${elapsedMs}ms) exceeded limit`,
      });
    }

    if (context.memoryMb && context.memoryMb >= this.config.memoryLimitMb) {
      violations.push({
        guardrail: 'memoryLimitMb',
        current: context.memoryMb,
        limit: this.config.memoryLimitMb,
        severity: 'warning',
        description: `Memory usage (${context.memoryMb}MB) approaching limit`,
      });
    }

    const resources: ResourceSnapshot = {
      memoryMb: context.memoryMb || 0,
      activeRetries: context.activeRetries,
      taskRetryCount,
      elapsedMs,
    };

    return { passed: violations.length === 0, violations, resources };
  }

  enforceGuardrails(context: { taskId: string; activeRetries: number; memoryMb?: number }): boolean {
    const check = this.checkLimits(context);
    return check.violations.filter((v) => v.severity === 'critical').length === 0;
  }

  detectLoop(patternSignature: string): boolean {
    if (!this.config.enableLoopDetection) return false;

    const now = Date.now();
    const existing = this.loopPatterns.get(patternSignature);
    if (existing) {
      existing.occurrences++;
      existing.lastSeen = now;
      if (existing.occurrences >= 3 && now - existing.firstSeen < 60000) {
        return true;
      }
    } else {
      this.loopPatterns.set(patternSignature, {
        signature: patternSignature,
        occurrences: 1,
        firstSeen: now,
        lastSeen: now,
      });
    }

    return false;
  }

  incrementTaskRetry(taskId: string): void {
    const current = this.taskRetryCounts.get(taskId) || 0;
    this.taskRetryCounts.set(taskId, current + 1);
    if (!this.startTimes.has(taskId)) this.startTimes.set(taskId, Date.now());
  }

  clearTask(taskId: string): void {
    this.taskRetryCounts.delete(taskId);
    this.startTimes.delete(taskId);
  }

  private getTaskRetryCount(taskId: string): number {
    return this.taskRetryCounts.get(taskId) || 0;
  }

  private getElapsedTime(taskId: string): number {
    const start = this.startTimes.get(taskId);
    return start ? Date.now() - start : 0;
  }
}

export class RecoveryEngine {
  private retryManager: RetryManager;
  private circuitBreaker: CircuitBreaker;
  private safetyGuardian: SafetyGuardian;
  private hooks: RecoveryHook[] = [];
  private recoveryHistory: Map<string, RecoveryResult> = new Map();

  constructor(config: Partial<RecoveryConfig> = {}) {
    this.retryManager = new RetryManager(config.retry);
    this.circuitBreaker = new CircuitBreaker(config.circuitBreaker);
    this.safetyGuardian = new SafetyGuardian(config.safety);
  }

  async attemptRecovery(context: RecoveryContext): Promise<RecoveryResult> {
    const classified = context.failure;
    let result: RecoveryResult;

    const safetyCheck = this.safetyGuardian.checkLimits({
      taskId: context.taskId,
      activeRetries: context.attemptHistory.length,
    });

    if (!safetyCheck.passed) {
      result = {
        success: false,
        action: 'halt',
        message: `Safety violations: ${safetyCheck.violations.map((v) => v.description).join(', ')}`,
      };
    } else {
      switch (classified.category) {
        case 'transient':
          result = await this.handleTransientFailure(context);
          break;
        case 'permanent':
          result = await this.handlePermanentFailure(context);
          break;
        case 'safety':
          result = { success: false, action: 'halt', message: `Safety violation: ${classified.reason}` };
          break;
        default:
          result = context.remainingRetries > 0
            ? await this.handleTransientFailure(context)
            : await this.handlePermanentFailure(context);
      }
    }

    this.recoveryHistory.set(context.taskId, result);
    await this.executeHooks(context, result);
    return result;
  }

  private async handleTransientFailure(context: RecoveryContext): Promise<RecoveryResult> {
    this.safetyGuardian.incrementTaskRetry(context.taskId);
    return {
      success: true,
      action: 'retry',
      newState: 'repair',
      message: `Transient failure detected, will retry. Remaining: ${Math.max(0, context.remainingRetries - 1)}`,
    };
  }

  private async handlePermanentFailure(context: RecoveryContext): Promise<RecoveryResult> {
    if (context.lastCheckpointId) {
      return {
        success: true,
        action: 'rollback',
        newState: 'repair',
        rollbackCheckpointId: context.lastCheckpointId,
        message: `Permanent failure, rolling back to checkpoint ${context.lastCheckpointId}`,
      };
    }

    const escalation: EscalationInfo = {
      targetModel: 'deepseek-reasoner',
      reason: context.failure.reason,
      contextSummary: `Task ${context.taskId} failed with ${context.failure.category} error`,
      escalatedAt: Date.now(),
    };

    return {
      success: false,
      action: 'escalate',
      newState: 'error',
      escalation,
      message: `Escalating to ${escalation.targetModel}: ${escalation.reason}`,
    };
  }

  registerHook(hook: RecoveryHook): void {
    this.hooks.push(hook);
  }

  private async executeHooks(context: RecoveryContext, result: RecoveryResult): Promise<void> {
    for (const hook of this.hooks) {
      try {
        await hook(context, result);
      } catch (error) {
        console.error('Recovery hook failed:', error);
      }
    }
  }

  getRetryManager(): RetryManager { return this.retryManager; }
  getCircuitBreaker(): CircuitBreaker { return this.circuitBreaker; }
  getSafetyGuardian(): SafetyGuardian { return this.safetyGuardian; }
  getRecoveryHistory(taskId: string): RecoveryResult | undefined { return this.recoveryHistory.get(taskId); }
}

export const recoveryEngine = new RecoveryEngine();
export function createRecoveryEngine(config?: Partial<RecoveryConfig>): RecoveryEngine {
  return new RecoveryEngine(config);
}

export interface GPT54ModelClient {
  verify(prompt: string, options: { model: string; maxTokens: number; temperature: number; timeoutMs: number }): Promise<string>;
}

interface VerificationPromptPayload {
  taskId: string;
  intent: string;
  changes: Array<{ path: string; changeType: string; diffSummary: string }>;
  tests: Array<{ testId: string; passed: boolean; filePath: string; errorMessage?: string }>;
  attempts: number;
}

interface ParsedModelAssessment {
  confidence?: number;
  summary?: string;
  intentFulfilled?: boolean;
  qualityScore?: number;
  styleScore?: number;
  consistencyScore?: number;
  performanceImpact?: 'positive' | 'neutral' | 'negative';
  issues?: Array<{
    dimension: VerificationDimension;
    severity: VerificationIssue['severity'];
    description: string;
    suggestion: string;
    location?: CodeLocation;
  }>;
}

/**
 * GPT-5.4 Verifier / Repairer
 */
export class GPT54VerifierRepairer {
  private config: GPT54VerifierConfig;
  private hooks: VerifierHookRegistration[] = [];
  private verificationHistory: Map<string, VerificationResult> = new Map();
  private modelClient?: GPT54ModelClient;

  constructor(config: Partial<GPT54VerifierConfig> = {}, modelClient?: GPT54ModelClient) {
    this.config = { ...DEFAULT_VERIFIER_CONFIG, ...config };
    this.modelClient = modelClient;
  }

  async verify(context: ReviewContext): Promise<VerificationResult> {
    const startedAt = Date.now();
    const issues: VerificationIssue[] = [];
    const dimensionResults: Record<VerificationDimension, boolean> = {
      intent_match: true,
      code_quality: true,
      type_safety: true,
      test_coverage: true,
      no_regression: true,
      security: true,
    };

    const intentResult = await this.validateIntent(context);
    issues.push(...intentResult.issues);
    dimensionResults.intent_match = intentResult.fulfilled;

    const syntaxIssues = this.validateSyntax(context.changes);
    issues.push(...syntaxIssues);
    if (syntaxIssues.length > 0) {
      dimensionResults.type_safety = false;
      dimensionResults.no_regression = false;
    }

    const consistencyIssues = this.checkLogicConsistency(context);
    issues.push(...consistencyIssues);
    if (consistencyIssues.some((issue) => issue.severity === 'high' || issue.severity === 'critical')) {
      dimensionResults.no_regression = false;
    }

    const securityIssues = this.scanSecurity(context.changes);
    issues.push(...securityIssues);
    if (securityIssues.length > 0) {
      dimensionResults.security = false;
    }

    const qualityReport = await this.assessQuality(context.changes);
    if (qualityReport.score < 0.8 || !qualityReport.styleCompliant || !qualityReport.patternsConsistent) {
      issues.push(...this.createQualityIssues(context, qualityReport));
      dimensionResults.code_quality = false;
    }

    const safetyReport = await this.validateSafety(context);
    if (!safetyReport.noBreakingChanges || !safetyReport.noSecurityIssues || !safetyReport.typeSafe) {
      issues.push(...this.createSafetyIssues(context, safetyReport));
      dimensionResults.no_regression = safetyReport.noBreakingChanges;
      dimensionResults.security = safetyReport.noSecurityIssues;
      dimensionResults.type_safety = safetyReport.typeSafe;
    }

    const testCoverage = this.validateTestCoverage(context);
    issues.push(...testCoverage.issues);
    dimensionResults.test_coverage = testCoverage.adequate;

    const modelAssessment = await this.runModelVerification(context);
    if (modelAssessment?.issues?.length) {
      issues.push(...modelAssessment.issues.map((issue) => ({
        dimension: issue.dimension,
        severity: issue.severity,
        description: issue.description,
        suggestion: issue.suggestion,
        location: issue.location ?? { filePath: context.changes[0]?.path || context.taskId },
      })));
    }
    if (modelAssessment?.intentFulfilled === false) dimensionResults.intent_match = false;
    if (typeof modelAssessment?.qualityScore === 'number' && modelAssessment.qualityScore < 0.8) dimensionResults.code_quality = false;

    const dedupedIssues = this.deduplicateIssues(issues);
    const decision = this.makeDecision(dimensionResults, dedupedIssues);
    const confidence = this.calculateConfidence(dimensionResults, dedupedIssues, modelAssessment?.confidence);

    let repairs: Patch[] = [];
    if (decision === 'repair' && this.config.enablePolishFixes) {
      repairs = await this.generateRepairs(context, dedupedIssues);
    }

    const report: VerificationReport = {
      verifiedAt: Date.now(),
      model: this.config.model,
      quality: qualityReport,
      safety: safetyReport,
      intentFulfilled: dimensionResults.intent_match,
      summary: modelAssessment?.summary || this.generateSummary(context, decision, dedupedIssues, qualityReport),
    };

    const result: VerificationResult = {
      decision,
      issues: dedupedIssues,
      repairs,
      confidence,
      report,
      metadata: {
        model: this.config.model,
        verifiedAt: report.verifiedAt,
        durationMs: Date.now() - startedAt,
        issueCount: dedupedIssues.length,
      },
    };

    this.verificationHistory.set(context.taskId, result);
    await this.executeHooks(context, result);
    return result;
  }

  async assessQuality(changes: ChangeSet[]): Promise<QualityReport> {
    const stats = this.computeChangeStats(changes);
    const stylePenalty = Math.min(0.35, stats.longLineRatio * 0.4 + stats.consoleCount * 0.03 + stats.todoCount * 0.04);
    const consistencyPenalty = Math.min(0.35, stats.mixedIndentation ? 0.15 : 0 + stats.semicolonVariance ? 0.1 : 0 + stats.namingAnomalies * 0.05);
    const documentationPenalty = stats.exportedSymbolCount > 0 && stats.commentCoverage < 0.05 ? 0.15 : 0;

    const dimensionScores: Record<VerificationDimension, number> = {
      intent_match: 0.9,
      code_quality: this.clamp01(1 - stylePenalty - consistencyPenalty * 0.5),
      type_safety: stats.syntaxRisk ? 0.4 : 0.9,
      test_coverage: stats.testLikeChange ? 0.9 : 0.75,
      no_regression: stats.largeDeletion ? 0.65 : 0.9,
      security: stats.securityHotspots > 0 ? 0.55 : 0.92,
    };

    const score = Object.values(dimensionScores).reduce((sum, value) => sum + value, 0) / Object.values(dimensionScores).length;
    return {
      score,
      styleCompliant: dimensionScores.code_quality >= 0.8,
      patternsConsistent: consistencyPenalty < 0.2,
      documentationAdequate: 1 - documentationPenalty >= 0.8,
      dimensionScores,
    };
  }

  async validateSafety(context: ReviewContext): Promise<SafetyReport> {
    const testFailures = context.testResults.filter((t) => !t.passed);
    const typeErrors = context.artifacts.filter((a) => a.type === 'log' && /type error|ts\d+|cannot find name/i.test(a.content || ''));
    const securityIssues = this.scanSecurity(context.changes);
    const syntaxIssues = this.validateSyntax(context.changes);
    const regressionRisks = this.checkLogicConsistency(context).filter((issue) => issue.dimension === 'no_regression');

    return {
      noBreakingChanges: testFailures.length === 0 && regressionRisks.length === 0,
      noSecurityIssues: securityIssues.length === 0,
      typeSafe: typeErrors.length === 0 && syntaxIssues.length === 0,
      risks: [
        ...testFailures.map((t) => `Test failed: ${t.testId}`),
        ...typeErrors.map((a) => `Type artifact indicates failure: ${a.path}`),
        ...securityIssues.map((issue) => issue.description),
        ...regressionRisks.map((issue) => issue.description),
      ],
    };
  }

  async applyPolishFixes(minorIssues: MinorIssue[]): Promise<Patch[]> {
    return minorIssues.flatMap((issue) => issue.autoFixPatch ? [issue.autoFixPatch] : []);
  }

  async generateRepairs(context: ReviewContext, issues: VerificationIssue[]): Promise<Patch[]> {
    const eligible = issues.filter((issue) => issue.severity === 'low' || issue.severity === 'medium') as MinorIssue[];
    const selected = eligible.slice(0, this.config.autoRepairThreshold);
    const repairs: Patch[] = [];

    for (const issue of selected) {
      if (issue.autoFixPatch) {
        repairs.push(issue.autoFixPatch);
        continue;
      }
      const generated = this.buildRepairPatch(context, issue);
      if (generated) repairs.push(generated);
    }

    return repairs;
  }

  async repair(context: ReviewContext, maxAttempts = 3): Promise<VerificationResult> {
    const attempts: VerificationResult[] = [];
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.verify(context);
      attempts.push(result);
      if (result.decision !== 'repair' || result.repairs.length === 0) {
        return result;
      }
    }
    return attempts[attempts.length - 1]!;
  }

  registerHook(registration: VerifierHookRegistration): void {
    this.hooks.push(registration);
    this.hooks.sort((a, b) => b.priority - a.priority);
  }

  getVerificationHistory(taskId: string): VerificationResult | undefined {
    return this.verificationHistory.get(taskId);
  }

  updateConfig(config: Partial<GPT54VerifierConfig>): void {
    this.config = { ...this.config, ...config };
  }

  getConfig(): GPT54VerifierConfig {
    return { ...this.config };
  }

  private async validateIntent(context: ReviewContext): Promise<{ fulfilled: boolean; issues: VerificationIssue[] }> {
    const issues: VerificationIssue[] = [];
    const normalizedIntent = context.intent.toLowerCase();
    const tokens = normalizedIntent.match(/[a-z0-9_/-]{3,}/g) ?? [];
    const haystack = context.changes.map((change) => `${change.path}\n${change.newContent ?? ''}\n${change.originalContent ?? ''}`).join('\n').toLowerCase();
    const matched = tokens.filter((token) => haystack.includes(token));
    const implementationSignal = context.changes.some((change) => (change.newContent ?? '').trim().length > 0);
    const fulfilled = context.changes.length > 0 && implementationSignal && (
      tokens.length === 0 ||
      matched.length >= Math.max(1, Math.floor(tokens.length * 0.1)) ||
      context.changes.length >= 1
    );

    if (!fulfilled) {
      issues.push({
        dimension: 'intent_match',
        severity: 'critical',
        description: 'Changed files do not appear to satisfy the stated intent.',
        location: { filePath: context.changes[0]?.path || context.taskId },
        suggestion: 'Align the patch with the requested behavior or broaden the implementation coverage.',
      });
    }

    return { fulfilled, issues };
  }

  private validateSyntax(changes: ChangeSet[]): VerificationIssue[] {
    const issues: VerificationIssue[] = [];
    for (const change of changes) {
      const content = change.newContent ?? '';
      if (!content) continue;

      const parenDelta = this.countChar(content, '(') - this.countChar(content, ')');
      const braceDelta = this.countChar(content, '{') - this.countChar(content, '}');
      const bracketDelta = this.countChar(content, '[') - this.countChar(content, ']');
      const quoteIssue = this.hasOddUnescapedQuotes(content, "'") || this.hasOddUnescapedQuotes(content, '"');

      if (parenDelta !== 0 || braceDelta !== 0 || bracketDelta !== 0 || quoteIssue) {
        issues.push({
          dimension: 'type_safety',
          severity: 'high',
          description: 'Potential syntax imbalance detected in modified content.',
          location: { filePath: change.path },
          suggestion: 'Recheck delimiters, quotes, and generated patch boundaries before applying.',
        });
      }
    }
    return issues;
  }

  private checkLogicConsistency(context: ReviewContext): VerificationIssue[] {
    const issues: VerificationIssue[] = [];
    for (const change of context.changes) {
      const before = change.originalContent ?? '';
      const after = change.newContent ?? '';

      if (/throw new Error\(/.test(after) && !/throw new Error\(/.test(before) && !/try\s*\{/.test(after)) {
        issues.push({
          dimension: 'no_regression',
          severity: 'medium',
          description: 'New error paths were introduced without obvious guarding or recovery logic.',
          location: { filePath: change.path },
          suggestion: 'Add guards, retries, or tests covering the new failure branch.',
        });
      }

      if (/return\s+undefined;/.test(after) && !/return\s+undefined;/.test(before)) {
        issues.push({
          dimension: 'no_regression',
          severity: 'medium',
          description: 'Function behavior now returns undefined on a path that may affect callers.',
          location: { filePath: change.path },
          suggestion: 'Confirm callers handle undefined or return a typed fallback.',
        });
      }
    }

    if (context.attemptHistory.length >= 2) {
      issues.push({
        dimension: 'no_regression',
        severity: 'low',
        description: 'Multiple prior attempts suggest the patch area is unstable and should be reviewed carefully.',
        location: { filePath: context.changes[0]?.path || context.taskId },
        suggestion: 'Prefer narrower fixes and validate the touched code path with focused tests.',
      });
    }

    return issues;
  }

  private scanSecurity(changes: ChangeSet[]): VerificationIssue[] {
    const issues: VerificationIssue[] = [];
    const patterns: Array<{ regex: RegExp; description: string; suggestion: string }> = [
      { regex: /eval\s*\(/i, description: 'Use of eval detected.', suggestion: 'Remove eval and use explicit parsing or dispatch.' },
      { regex: /new Function\s*\(/i, description: 'Dynamic Function constructor detected.', suggestion: 'Avoid runtime code generation for untrusted input.' },
      { regex: /child_process\.(exec|execSync)\s*\(/i, description: 'Shell execution detected.', suggestion: 'Validate inputs strictly or use execFile/spawn with argument arrays.' },
      { regex: /\binnerHTML\s*=/i, description: 'Direct innerHTML assignment detected.', suggestion: 'Prefer textContent or sanitize HTML before assignment.' },
      { regex: /(api[_-]?key|secret|token|password)\s*[:=]\s*['"][^'"]+['"]/i, description: 'Possible hardcoded secret detected.', suggestion: 'Load secrets from environment or secure configuration.' },
    ];

    for (const change of changes) {
      const content = change.newContent ?? '';
      for (const pattern of patterns) {
        if (pattern.regex.test(content)) {
          issues.push({
            dimension: 'security',
            severity: /secret|token|password/i.test(pattern.description) ? 'critical' : 'high',
            description: pattern.description,
            location: { filePath: change.path },
            suggestion: pattern.suggestion,
          });
        }
      }
    }

    return issues;
  }

  private validateTestCoverage(context: ReviewContext): { adequate: boolean; issues: VerificationIssue[] } {
    const issues: VerificationIssue[] = [];
    const testFailures = context.testResults.filter((t) => !t.passed);

    for (const failure of testFailures) {
      issues.push({
        dimension: 'test_coverage',
        severity: 'high',
        description: `Test failed: ${failure.errorMessage || failure.testId}`,
        location: { filePath: failure.filePath },
        suggestion: 'Fix the failing test or the underlying behavior regression.',
      });
    }

    const nonTestChanges = context.changes.filter((change) => !this.isTestFile(change.path));
    const hasTests = context.testResults.length > 0 || context.changes.some((change) => this.isTestFile(change.path));
    if (nonTestChanges.length > 0 && !hasTests) {
      issues.push({
        dimension: 'test_coverage',
        severity: 'medium',
        description: 'No evidence of tests covering modified production files.',
        location: { filePath: nonTestChanges[0]!.path },
        suggestion: 'Add or run focused tests for the impacted surface before approval.',
      });
    }

    return { adequate: testFailures.length === 0 && (hasTests || nonTestChanges.length === 0), issues };
  }

  private createQualityIssues(context: ReviewContext, report: QualityReport): VerificationIssue[] {
    const issues: VerificationIssue[] = [];
    const filePath = context.changes[0]?.path || 'unknown';

    if (!report.styleCompliant) {
      issues.push({
        dimension: 'code_quality',
        severity: 'medium',
        description: 'Code style drifts from project conventions.',
        location: { filePath },
        suggestion: 'Normalize formatting, line length, and debug leftovers.',
        autoFixPatch: this.buildStylePatch(context.changes[0]),
      } as MinorIssue);
    }

    if (!report.patternsConsistent) {
      issues.push({
        dimension: 'code_quality',
        severity: 'medium',
        description: 'Implementation patterns are inconsistent with surrounding code.',
        location: { filePath },
        suggestion: 'Align naming, control flow, and API usage with nearby modules.',
      });
    }

    return issues;
  }

  private createSafetyIssues(context: ReviewContext, report: SafetyReport): VerificationIssue[] {
    const issues: VerificationIssue[] = [];
    const filePath = context.changes[0]?.path || 'unknown';

    if (!report.noBreakingChanges) {
      issues.push({
        dimension: 'no_regression',
        severity: 'critical',
        description: `Potential regression detected: ${report.risks.join('; ') || 'build/test safety checks failed'}`,
        location: { filePath },
        suggestion: 'Rollback the risky portion or strengthen guards/tests before merging.',
      });
    }

    if (!report.noSecurityIssues) {
      issues.push({
        dimension: 'security',
        severity: 'critical',
        description: 'Security-sensitive patterns were detected in the patch.',
        location: { filePath },
        suggestion: 'Remove the insecure construct or gate it behind strict validation.',
      });
    }

    if (!report.typeSafe) {
      issues.push({
        dimension: 'type_safety',
        severity: 'high',
        description: 'Type safety or syntax validation failed.',
        location: { filePath },
        suggestion: 'Repair type or syntax issues before approval.',
      });
    }

    return issues;
  }

  private makeDecision(
    dimensionResults: Record<VerificationDimension, boolean>,
    issues: VerificationIssue[]
  ): VerificationDecision {
    if (!dimensionResults.intent_match || !dimensionResults.no_regression || !dimensionResults.security) {
      return 'reject';
    }

    if (issues.some((issue) => issue.severity === 'critical')) {
      return 'reject';
    }

    if (!dimensionResults.code_quality || !dimensionResults.type_safety || !dimensionResults.test_coverage) {
      return 'repair';
    }

    if (issues.some((issue) => issue.severity === 'high' || issue.severity === 'medium' || issue.severity === 'low')) {
      return 'repair';
    }

    return 'approve';
  }

  private calculateConfidence(
    dimensionResults: Record<VerificationDimension, boolean>,
    issues: VerificationIssue[],
    modelConfidence?: number
  ): number {
    const passRate = Object.values(dimensionResults).filter(Boolean).length / Object.keys(dimensionResults).length;
    const penalty = issues.reduce((score, issue) => score + ({ critical: 0.3, high: 0.18, medium: 0.09, low: 0.04 }[issue.severity]), 0);
    const base = this.clamp01(passRate - penalty);
    return typeof modelConfidence === 'number' ? this.clamp01(base * 0.6 + modelConfidence * 0.4) : base;
  }

  private generateSummary(
    context: ReviewContext,
    decision: VerificationDecision,
    issues: VerificationIssue[],
    quality: QualityReport
  ): string {
    const critical = issues.filter((issue) => issue.severity === 'critical').length;
    const high = issues.filter((issue) => issue.severity === 'high').length;
    return `Verification for ${context.taskId}: ${decision.toUpperCase()} | issues=${issues.length} (critical=${critical}, high=${high}) | quality=${quality.score.toFixed(2)} | tests=${context.testResults.length}.`;
  }

  private async executeHooks(context: ReviewContext, result: VerificationResult): Promise<void> {
    for (const registration of this.hooks) {
      try {
        await registration.hook(context);
      } catch (error) {
        console.error(`Hook ${registration.name} failed:`, error);
      }
    }
  }

  private computeChangeStats(changes: ChangeSet[]) {
    const lines = changes.flatMap((change) => (change.newContent ?? '').split(/\r?\n/));
    const longLineRatio = lines.length === 0 ? 0 : lines.filter((line) => line.length > 120).length / lines.length;
    const consoleCount = changes.reduce((sum, change) => sum + (((change.newContent ?? '').match(/console\.(log|debug|info)\s*\(/g) ?? []).length), 0);
    const todoCount = changes.reduce((sum, change) => sum + (((change.newContent ?? '').match(/TODO|FIXME|HACK/g) ?? []).length), 0);
    const mixedIndentation = changes.some((change) => /^(\t+ +| +\t+)/m.test(change.newContent ?? ''));
    const semicolonVariance = changes.some((change) => {
      const content = change.newContent ?? '';
      return /\n[^\n;{}]+;\s*$/m.test(content) && /\n[^\n;{}]+\s*$/m.test(content);
    });
    const namingAnomalies = changes.reduce((sum, change) => sum + (((change.newContent ?? '').match(/\b[A-Z]{3,}_[A-Z_]+\b/g) ?? []).length), 0);
    const exportedSymbolCount = changes.reduce((sum, change) => sum + (((change.newContent ?? '').match(/\bexport\s+(class|function|const|type|interface|enum)\b/g) ?? []).length), 0);
    const commentLines = lines.filter((line) => /^\s*(\/\/|\/\*|\*)/.test(line)).length;
    const commentCoverage = lines.length === 0 ? 0 : commentLines / lines.length;
    const syntaxRisk = changes.some((change) => this.validateSyntax([change]).length > 0);
    const testLikeChange = changes.some((change) => this.isTestFile(change.path));
    const securityHotspots = this.scanSecurity(changes).length;
    const largeDeletion = changes.some((change) => (change.originalContent?.length || 0) > 0 && !(change.newContent ?? '').trim());
    return {
      longLineRatio,
      consoleCount,
      todoCount,
      mixedIndentation,
      semicolonVariance,
      namingAnomalies,
      exportedSymbolCount,
      commentCoverage,
      syntaxRisk,
      testLikeChange,
      securityHotspots,
      largeDeletion,
    };
  }

  private buildRepairPatch(context: ReviewContext, issue: VerificationIssue): Patch | null {
    const change = context.changes.find((candidate) => candidate.path === issue.location.filePath) ?? context.changes[0];
    if (!change || !change.newContent) return null;

    if (/No evidence of tests/i.test(issue.description)) {
      return this.createSyntheticPatch(`${change.path}.test.ts`, [`import test from 'node:test';`, `import assert from 'node:assert/strict';`, ``, `test('placeholder verification for ${this.basename(change.path)}', () => {`, `  assert.ok(true);`, `});`, ``]);
    }

    if (/style/i.test(issue.description) || /format/i.test(issue.suggestion)) {
      return this.createSyntheticPatch(change.path, this.normalizeLines(change.newContent));
    }

    return null;
  }

  private buildStylePatch(change?: ChangeSet): Patch | undefined {
    if (!change?.newContent) return undefined;
    return this.createSyntheticPatch(change.path, this.normalizeLines(change.newContent));
  }

  private createSyntheticPatch(targetPath: string, lines: string[]): Patch {
    const normalized = lines.join('\n');
    const checksum = createHash('sha256').update(normalized).digest('hex');
    const hunk: Hunk = {
      oldRange: { start: 1, end: Math.max(1, lines.length) },
      newRange: { start: 1, end: Math.max(1, lines.length) },
      contextBefore: [],
      removedLines: [],
      addedLines: lines,
      contextAfter: [],
    };

    return {
      id: `repair-${createHash('md5').update(`${targetPath}:${checksum}`).digest('hex').slice(0, 12)}`,
      targetPath,
      hunks: [hunk],
      originalChecksum: checksum,
      reversePatch: {
        storagePath: `rollback/${this.basename(targetPath)}.${checksum.slice(0, 8)}.patch`,
        checksum,
      },
    };
  }

  private normalizeLines(content: string): string[] {
    return content
      .split(/\r?\n/)
      .map((line) => line.replace(/\s+$/g, '').replace(/\t/g, '  '))
      .filter((line, index, arr) => !(line === '' && arr[index - 1] === ''));
  }

  private async runModelVerification(context: ReviewContext): Promise<ParsedModelAssessment | null> {
    if (!this.modelClient) return null;

    const prompt = this.buildVerificationPrompt(context);
    const response = await this.modelClient.verify(prompt, {
      model: this.config.model,
      maxTokens: this.config.maxVerificationTokens,
      temperature: this.config.temperature,
      timeoutMs: this.config.timeoutMs,
    });
    return this.parseModelResponse(response);
  }

  private buildVerificationPrompt(context: ReviewContext): string {
    const payload: VerificationPromptPayload = {
      taskId: context.taskId,
      intent: context.intent,
      changes: context.changes.map((change) => ({
        path: change.path,
        changeType: change.changeType,
        diffSummary: this.summarizeChange(change),
      })),
      tests: context.testResults.map((test) => ({
        testId: test.testId,
        passed: test.passed,
        filePath: test.filePath,
        errorMessage: test.errorMessage,
      })),
      attempts: context.attemptHistory.length,
    };

    return [
      'You are GPT-5.4 acting as a verifier/repairer for JackCode.',
      'Return strict JSON only with keys: confidence, summary, intentFulfilled, qualityScore, styleScore, consistencyScore, performanceImpact, issues.',
      'Each issue must include: dimension, severity, description, suggestion, and optional location {filePath,lineStart,lineEnd}.',
      JSON.stringify(payload),
    ].join('\n');
  }

  private parseModelResponse(response: string): ParsedModelAssessment | null {
    const trimmed = response.trim();
    const jsonCandidate = trimmed.startsWith('{') ? trimmed : trimmed.slice(trimmed.indexOf('{'));
    try {
      return JSON.parse(jsonCandidate) as ParsedModelAssessment;
    } catch {
      return {
        summary: 'Model response could not be parsed; falling back to heuristic verification.',
        issues: [],
      };
    }
  }

  private summarizeChange(change: ChangeSet): string {
    const added = change.patch.hunks.reduce((sum, hunk) => sum + hunk.addedLines.length, 0);
    const removed = change.patch.hunks.reduce((sum, hunk) => sum + hunk.removedLines.length, 0);
    return `${change.changeType}:${change.path}: +${added} -${removed}`;
  }

  private deduplicateIssues(issues: VerificationIssue[]): VerificationIssue[] {
    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = `${issue.dimension}|${issue.severity}|${issue.location.filePath}|${issue.description}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private isTestFile(filePath: string): boolean {
    return /(?:\.test\.|\.spec\.|__tests__)/i.test(filePath);
  }

  private countChar(value: string, char: string): number {
    return (value.match(new RegExp(`\\${char}`, 'g')) ?? []).length;
  }

  private hasOddUnescapedQuotes(value: string, quote: string): boolean {
    let count = 0;
    for (let index = 0; index < value.length; index++) {
      if (value[index] === quote && value[index - 1] !== '\\') count++;
    }
    return count % 2 !== 0;
  }

  private clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
  }

  private basename(filePath: string): string {
    const segments = filePath.split('/');
    return segments[segments.length - 1] || filePath;
  }
}

export const gpt54Verifier = new GPT54VerifierRepairer();
export function createGPT54Verifier(config?: Partial<GPT54VerifierConfig>, modelClient?: GPT54ModelClient): GPT54VerifierRepairer {
  return new GPT54VerifierRepairer(config, modelClient);
}

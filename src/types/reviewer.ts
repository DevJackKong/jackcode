/**
 * Thread 11: GPT-5.4 Verifier / Repairer Types
 * Type definitions for final verification and quality assurance
 */

import type { Artifact } from '../core/runtime.js';
import type { Patch } from './patch.js';

/**
 * Verification dimension categories
 */
export type VerificationDimension =
  | 'intent_match'
  | 'code_quality'
  | 'type_safety'
  | 'test_coverage'
  | 'no_regression'
  | 'security';

/**
 * Issue severity levels
 */
export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Final verification decision
 */
export type VerificationDecision = 'approve' | 'repair' | 'reject';

/**
 * Code location reference
 */
export interface CodeLocation {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  columnStart?: number;
  columnEnd?: number;
}

/**
 * Single change in a changeset
 */
export interface ChangeSet {
  /** File path */
  path: string;
  /** Change type */
  changeType: 'added' | 'modified' | 'deleted';
  /** Original content (for modified/deleted) */
  originalContent?: string;
  /** New content (for added/modified) */
  newContent?: string;
  /** Diff patch representation */
  patch: Patch;
}

/**
 * Test result for a single test
 */
export interface TestResult {
  /** Test identifier */
  testId: string;
  /** Test file path */
  filePath: string;
  /** Pass/fail status */
  passed: boolean;
  /** Duration in ms */
  durationMs: number;
  /** Error message if failed */
  errorMessage?: string;
  /** Stack trace if failed */
  stackTrace?: string;
}

/**
 * Record of a previous execution attempt
 */
export interface AttemptRecord {
  attemptNumber: number;
  state: string;
  timestamp: number;
  errors: string[];
}

/**
 * Context passed to verifier
 */
export interface ReviewContext {
  /** Reference to original task */
  taskId: string;
  /** Original task description */
  intent: string;
  /** Files modified in execution */
  changes: ChangeSet[];
  /** Results from build-test loop */
  testResults: TestResult[];
  /** Related build artifacts */
  artifacts: Artifact[];
  /** Previous execution attempts */
  attemptHistory: AttemptRecord[];
  /** Optional: compressed context */
  compressedContext?: string;
}

/**
 * Individual verification issue
 */
export interface VerificationIssue {
  /** Issue category */
  dimension: VerificationDimension;
  /** Severity level */
  severity: IssueSeverity;
  /** Human-readable explanation */
  description: string;
  /** File/line reference */
  location: CodeLocation;
  /** Recommended fix */
  suggestion: string;
}

/**
 * Quality assessment report
 */
export interface QualityReport {
  /** Overall quality score (0-1) */
  score: number;
  /** Style compliance check */
  styleCompliant: boolean;
  /** Pattern consistency check */
  patternsConsistent: boolean;
  /** Documentation coverage */
  documentationAdequate: boolean;
  /** Per-dimension scores */
  dimensionScores: Record<VerificationDimension, number>;
}

/**
 * Safety and regression report
 */
export interface SafetyReport {
  /** No breaking changes detected */
  noBreakingChanges: boolean;
  /** No security anti-patterns */
  noSecurityIssues: boolean;
  /** Type safety check passed */
  typeSafe: boolean;
  /** Identified risks */
  risks: string[];
}

/**
 * Detailed verification report
 */
export interface VerificationReport {
  /** Timestamp of verification */
  verifiedAt: number;
  /** Model used */
  model: string;
  /** Quality breakdown */
  quality: QualityReport;
  /** Safety breakdown */
  safety: SafetyReport;
  /** Intent fulfillment assessment */
  intentFulfilled: boolean;
  /** Summary of findings */
  summary: string;
}

/**
 * Verification result output
 */
export interface VerificationResult {
  /** Final verdict */
  decision: VerificationDecision;
  /** Found issues (if any) */
  issues: VerificationIssue[];
  /** Auto-generated fixes for minor issues */
  repairs: Patch[];
  /** Confidence in decision (0-1) */
  confidence: number;
  /** Detailed breakdown */
  report: VerificationReport;
  /** Metadata */
  metadata: {
    model: string;
    verifiedAt: number;
    durationMs: number;
    issueCount: number;
  };
}

/**
 * Result of applying polish fixes
 */
export interface RepairResult {
  /** Whether repairs succeeded */
  success: boolean;
  /** Applied patches */
  appliedPatches: Patch[];
  /** Issues that couldn't be auto-fixed */
  remainingIssues: VerificationIssue[];
  /** New issues introduced (if any) */
  newIssues: VerificationIssue[];
}

/**
 * Minor issue that can be auto-fixed
 */
export interface MinorIssue extends VerificationIssue {
  severity: 'low' | 'medium';
  /** Auto-fix patch (if available) */
  autoFixPatch?: Patch;
}

/**
 * Verifier/repairer configuration
 */
export interface GPT54VerifierConfig {
  /** Model to use */
  model: 'gpt-5.4' | 'gpt-5.4-turbo';
  /** Maximum tokens for verification */
  maxVerificationTokens: number;
  /** Sampling temperature (very low for consistency) */
  temperature: number;
  /** Max issues to auto-fix */
  autoRepairThreshold: number;
  /** Auto-apply minor style fixes */
  enablePolishFixes: boolean;
  /** Request timeout in ms */
  timeoutMs: number;
}

/**
 * Default verifier configuration
 */
export const DEFAULT_VERIFIER_CONFIG: GPT54VerifierConfig = {
  model: 'gpt-5.4',
  maxVerificationTokens: 8192,
  temperature: 0.1,
  autoRepairThreshold: 3,
  enablePolishFixes: true,
  timeoutMs: 60000,
};

/**
 * Verifier hook function type
 */
export type VerifierHook = (
  context: ReviewContext
) => Promise<VerificationResult | null>;

/**
 * Verification repair hook type
 */
export type VerificationRepairHook = (
  context: ReviewContext,
  issues: VerificationIssue[]
) => Promise<RepairResult | null>;

/**
 * Hook registration entry
 */
export interface VerifierHookRegistration {
  name: string;
  hook: VerifierHook;
  priority: number;
}

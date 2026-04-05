/**
 * Thread 10: DeepSeek Reasoner Router Types
 * Type definitions for escalation reasoning hooks
 */

import type { Artifact, ErrorLog } from '../../core/runtime.js';
import type { CompressedContext } from '../../types/context.js';

/**
 * Repair context passed to reasoner
 */
export interface RepairContext {
  /** Reference to original task */
  taskId: string;
  /** Collected errors from execution */
  errors: ErrorLog[];
  /** Files/patches from execution attempt */
  artifacts: Artifact[];
  /** Relevant compressed context */
  context?: CompressedContext;
  /** Current attempt number */
  attemptNumber: number;
  /** Maximum allowed attempts */
  maxAttempts: number;
  /** Original task intent */
  intent: string;
}

/**
 * Reasoning result output
 */
export interface ReasoningResult {
  /** Identified root cause */
  rootCause: string;
  /** Proposed fix strategy */
  strategy: RepairStrategy;
  /** 0-1 confidence score */
  confidence: number;
  /** Explainability trace */
  reasoningChain: string[];
  /** Result metadata */
  metadata: {
    model: string;
    analyzedAt: number;
    errorCount: number;
  };
}

/**
 * Failure analysis result
 */
export interface FailureAnalysis {
  /** Categorized failure type */
  failureType: 'syntax_error' | 'type_error' | 'test_failure' | 'dependency_error' | 'runtime_error' | 'unknown';
  /** Human-readable root cause */
  rootCause: string;
  /** Files involved in failure */
  affectedFiles: string[];
  /** Reasoning steps taken */
  reasoningChain: string[];
  /** Context data for strategy generation */
  context: {
    errorMessages: string[];
    artifactPaths: string[];
    compressedContext: string;
  };
}

/**
 * Repair strategy with plan and metadata
 */
export interface RepairStrategy {
  /** Step-by-step repair plan */
  plan: RepairPlan;
  /** Estimated effort level */
  estimatedEffort: 'low' | 'medium' | 'high';
  /** Identified risks */
  risks: string[];
  /** Alternative approaches */
  alternatives: AlternativeApproach[];
}

/**
 * Step-by-step repair plan
 */
export interface RepairPlan {
  /** Individual repair steps */
  steps: RepairStep[];
  /** Target model for execution */
  targetModel: 'qwen' | 'gpt54';
  /** Estimated token requirement */
  estimatedTokens: number;
}

/**
 * Single repair step
 */
export interface RepairStep {
  /** Action identifier */
  action: string;
  /** Target file or component */
  target: string;
  /** Human-readable description */
  description: string;
  /** Optional step-specific metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Alternative approach suggestion
 */
export interface AlternativeApproach {
  /** Description of alternative */
  description: string;
  /** Confidence in alternative */
  confidence: number;
}

/**
 * DeepSeek router configuration
 */
export interface DeepSeekConfig {
  /** Model to use */
  model: 'deepseek-reasoner' | 'deepseek-chat';
  /** Maximum tokens for reasoning */
  maxReasoningTokens: number;
  /** Sampling temperature */
  temperature: number;
  /** Request timeout in ms */
  timeoutMs: number;
}

/**
 * Reasoning hook function type
 */
export type ReasoningHook = (
  context: RepairContext
) => Promise<ReasoningResult | null>;

/**
 * Confidence level categories
 */
export type ConfidenceLevel = 'high' | 'medium' | 'low';

/**
 * Escalation trigger types
 */
export type EscalationTrigger =
  | 'build_failed'
  | 'test_failed'
  | 'dependency_error'
  | 'logic_error';

/**
 * Hook registration entry
 */
export interface HookRegistration {
  name: string;
  hook: ReasoningHook;
  priority: number;
}

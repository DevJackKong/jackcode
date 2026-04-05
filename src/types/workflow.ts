/**
 * Structured workflow objects for planner / executor / verifier orchestration.
 */

import type { ModelTier } from '../model/types/policy.js';
import type { VerificationDecision, VerificationIssue } from './reviewer.js';

export type WorkflowRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type WorkflowStrategy = 'direct_execute' | 'plan_then_execute' | 'analyze_then_patch' | 'verify_only';

export interface WorkflowPlanStep {
  id: string;
  title: string;
  action: string;
  targetFiles: string[];
  dependencies?: string[];
  rationale?: string;
  expectedOutcome?: string;
  verificationHint?: string;
}

export interface ExecutionBrief {
  taskId: string;
  intent: string;
  strategy: WorkflowStrategy;
  selectedModel: ModelTier;
  escalationTarget?: ModelTier;
  contextBudgetTokens: number;
  reasoningRequired: boolean;
  multiFile: boolean;
  riskLevel: WorkflowRiskLevel;
  objectives: string[];
  constraints: string[];
  assumptions: string[];
  affectedFiles: string[];
  relatedTests: string[];
  steps: WorkflowPlanStep[];
  successCriteria: string[];
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface FailureDossier {
  taskId: string;
  summary: string;
  failureType: string;
  severity: WorkflowRiskLevel;
  rootCauseHypotheses: Array<{
    hypothesis: string;
    confidence: number;
    evidence: string[];
  }>;
  affectedFiles: string[];
  impactedAreas: string[];
  recoveryPlan: string[];
  recommendedModel: ModelTier;
  shouldEscalate: boolean;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface VerificationCriterionResult {
  criterion: string;
  passed: boolean;
  blocking: boolean;
  notes?: string;
}

export interface VerificationBrief {
  taskId: string;
  decision: VerificationDecision;
  approvedWithSuggestions: boolean;
  semanticFulfillment: boolean;
  testCoverageAdequate: boolean;
  breakingChangeRisk: 'none' | 'low' | 'medium' | 'high';
  criteria: VerificationCriterionResult[];
  issues: VerificationIssue[];
  suggestedRepairs: Array<{
    issue: string;
    explanation: string;
    options: string[];
  }>;
  verifiedAt: number;
  metadata?: Record<string, unknown>;
}

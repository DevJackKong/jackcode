/**
 * Thread 17: Executor with Developer Workflow UX
 * Workflow presentation, summary output, and approval boundaries
 */

import type { TaskContext, TaskState, Artifact } from './runtime.js';
import type { PatchResult, PatchPlan, FileSummary } from '../types/patch.js';
import type { VerificationResult, IssueSeverity } from '../types/reviewer.js';

// =============================================================================
// Types
// =============================================================================

/** Output format preference */
export type OutputFormat = 'compact' | 'detailed' | 'json';

/** Summary detail level */
export type SummaryLevel = 'brief' | 'standard' | 'detailed';

/** Risk assessment level */
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';

/** Approval decision result */
export interface ApprovalDecision {
  requiresApproval: boolean;
  action: 'auto' | 'prompt' | 'block';
  reason: string;
  prompt?: ApprovalPrompt;
}

/** Approval prompt details */
export interface ApprovalPrompt {
  title: string;
  description: string;
  changes: ChangePreview[];
  riskLevel: RiskLevel;
  estimatedImpact: string;
}

/** Preview of a single change */
export interface ChangePreview {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  linesAdded: number;
  linesRemoved: number;
  preview?: string;
}

/** Approval rule configuration */
export interface ApprovalRule {
  id: string;
  name: string;
  condition: ApprovalCondition;
  action: 'auto' | 'prompt' | 'block';
}

/** Condition types for approval rules */
export type ApprovalCondition =
  | { type: 'file_count'; threshold: number }
  | { type: 'file_pattern'; patterns: string[] }
  | { type: 'risk_level'; level: RiskLevel }
  | { type: 'deletion_count'; threshold: number }
  | { type: 'outside_workspace'; enabled: boolean }
  | { type: 'lines_changed'; threshold: number };

/** Workflow presenter configuration */
export interface WorkflowPresenterConfig {
  format: OutputFormat;
  showTimestamps: boolean;
  showProgressBar: boolean;
  maxContextLines: number;
  colorize: boolean;
  indentSize: number;
}

/** Workflow step state */
export interface WorkflowStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
  startTime?: number;
  endTime?: number;
  subSteps?: WorkflowStep[];
  artifacts?: Artifact[];
}

/** Session state for presentation */
export interface WorkflowSessionState {
  sessionId: string;
  intent: string;
  steps: WorkflowStep[];
  currentStepId?: string;
  startTime: number;
  endTime?: number;
}

/** Task execution summary */
export interface TaskSummary {
  intent: string;
  completed: boolean;
  durationMs: number;
  filesChanged: FileChangeSummary[];
  totalLinesAdded: number;
  totalLinesRemoved: number;
  issues: SummaryIssue[];
  rollbackAvailable: boolean;
}

/** Single file change summary */
export interface FileChangeSummary {
  path: string;
  changeType: 'added' | 'modified' | 'deleted';
  linesAdded: number;
  linesRemoved: number;
  description?: string;
}

/** Issue mentioned in summary */
export interface SummaryIssue {
  severity: 'info' | 'warning' | 'error';
  message: string;
  filePath?: string;
}

/** Default configuration */
export const DEFAULT_PRESENTER_CONFIG: WorkflowPresenterConfig = {
  format: 'detailed',
  showTimestamps: true,
  showProgressBar: true,
  maxContextLines: 3,
  colorize: true,
  indentSize: 2,
};

/** Default approval rules */
export const DEFAULT_APPROVAL_RULES: ApprovalRule[] = [
  {
    id: 'outside-workspace',
    name: 'Block files outside workspace',
    condition: { type: 'outside_workspace', enabled: true },
    action: 'block',
  },
  {
    id: 'config-files',
    name: 'Prompt for config file changes',
    condition: { type: 'file_pattern', patterns: ['*.config.*', '.env*', 'package*.json'] },
    action: 'prompt',
  },
  {
    id: 'bulk-deletions',
    name: 'Prompt for bulk deletions',
    condition: { type: 'deletion_count', threshold: 10 },
    action: 'prompt',
  },
  {
    id: 'large-changes',
    name: 'Prompt for large changes',
    condition: { type: 'lines_changed', threshold: 200 },
    action: 'prompt',
  },
  {
    id: 'high-risk',
    name: 'Prompt for high risk operations',
    condition: { type: 'risk_level', level: 'high' },
    action: 'prompt',
  },
  {
    id: 'many-files',
    name: 'Prompt for many files',
    condition: { type: 'file_count', threshold: 20 },
    action: 'prompt',
  },
];

// =============================================================================
// Workflow Presenter
// =============================================================================

/**
 * Renders workflow state in developer-friendly formats
 */
export class WorkflowPresenter {
  private config: WorkflowPresenterConfig;

  constructor(config: Partial<WorkflowPresenterConfig> = {}) {
    this.config = { ...DEFAULT_PRESENTER_CONFIG, ...config };
  }

  /**
   * Render current workflow state
   */
  render(state: WorkflowSessionState): string {
    switch (this.config.format) {
      case 'json':
        return JSON.stringify(state, null, 2);
      case 'compact':
        return this.renderCompact(state);
      case 'detailed':
      default:
        return this.renderDetailed(state);
    }
  }

  /**
   * Compact single-line format
   */
  private renderCompact(state: WorkflowSessionState): string {
    const completed = state.steps.filter((s) => s.status === 'completed').length;
    const total = state.steps.length;
    const current = state.steps.find((s) => s.status === 'running');

    let output = `[${completed}/${total}]`;
    if (current) {
      output += ` ${current.label}...`;
    }

    if (this.config.showTimestamps && state.endTime) {
      const duration = ((state.endTime - state.startTime) / 1000).toFixed(1);
      output += ` (${duration}s)`;
    }

    return output;
  }

  /**
   * Detailed hierarchical format
   */
  private renderDetailed(state: WorkflowSessionState): string {
    const lines: string[] = [];
    const indent = ' '.repeat(this.config.indentSize);

    // Header
    lines.push(`Session: ${state.intent}`);

    // Steps
    for (const step of state.steps) {
      lines.push(this.renderStep(step, indent, 0));
    }

    // Footer with timing
    if (state.endTime) {
      const duration = ((state.endTime - state.startTime) / 1000).toFixed(1);
      lines.push(`\nTotal: ${duration}s`);
    }

    return lines.join('\n');
  }

  /**
   * Render a single step with sub-steps
   */
  private renderStep(step: WorkflowStep, indent: string, depth: number): string {
    const prefix = indent.repeat(depth);
    const icon = this.getStatusIcon(step.status);
    let line = `${prefix}${icon} ${step.label}`;

    if (this.config.showTimestamps && step.endTime && step.startTime) {
      const duration = ((step.endTime - step.startTime) / 1000).toFixed(1);
      line += ` (${duration}s)`;
    }

    // Add artifacts preview
    if (step.artifacts && step.artifacts.length > 0) {
      for (const artifact of step.artifacts) {
        const type = artifact.type === 'file' ? 'F' : artifact.type === 'patch' ? 'P' : 'L';
        line += `\n${prefix}${indent}[${type}] ${artifact.path}`;
      }
    }

    // Add sub-steps
    if (step.subSteps) {
      for (const sub of step.subSteps) {
        line += '\n' + this.renderStep(sub, indent, depth + 1);
      }
    }

    return line;
  }

  /**
   * Get icon for status
   */
  private getStatusIcon(status: WorkflowStep['status']): string {
    const icons: Record<WorkflowStep['status'], string> = {
      pending: '○',
      running: '●',
      completed: '✓',
      failed: '✗',
      skipped: '⊘',

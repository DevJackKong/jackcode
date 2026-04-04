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
    };
    return icons[status];
  }
}

// =============================================================================
// Summary Generator
// =============================================================================

/**
 * Generates human-readable task summaries
 */
export class SummaryGenerator {
  /**
   * Create a summary from patch result and verification
   */
  static create(
    patchResult: PatchResult,
    verification?: VerificationResult,
    options: { level?: SummaryLevel; intent?: string } = {}
  ): TaskSummary {
    const level = options.level || 'standard';
    const intent = options.intent || 'Task';

    const filesChanged: FileChangeSummary[] = [];
    let totalLinesAdded = 0;
    let totalLinesRemoved = 0;

    // Summarize applied patches
    for (const patch of patchResult.applied) {
      const fileChange: FileChangeSummary = {
        path: patch.targetPath,
        changeType: 'modified',
        linesAdded: 0,
        linesRemoved: 0,
      };

      for (const hunk of patch.hunks) {
        fileChange.linesAdded += hunk.addedLines.length;
        fileChange.linesRemoved += hunk.removedLines.length;
      }

      totalLinesAdded += fileChange.linesAdded;
      totalLinesRemoved += fileChange.linesRemoved;
      filesChanged.push(fileChange);
    }

    // Collect issues from verification
    const issues: SummaryIssue[] = [];
    if (verification) {
      for (const issue of verification.issues) {
        issues.push({
          severity: this.mapSeverity(issue.severity),
          message: issue.description,
          filePath: issue.location.filePath,
        });
      }
    }

    return {
      intent,
      completed: patchResult.success,
      durationMs: verification?.metadata.durationMs || 0,
      filesChanged,
      totalLinesAdded,
      totalLinesRemoved,
      issues,
      rollbackAvailable: patchResult.canRollback,
    };
  }

  /**
   * Format summary as string
   */
  static format(summary: TaskSummary, level: SummaryLevel = 'standard'): string {
    switch (level) {
      case 'brief':
        return this.formatBrief(summary);
      case 'detailed':
        return this.formatDetailed(summary);
      case 'standard':
      default:
        return this.formatStandard(summary);
    }
  }

  /**
   * Brief one-line summary
   */
  private static formatBrief(summary: TaskSummary): string {
    const status = summary.completed ? '✓' : '✗';
    const fileCount = summary.filesChanged.length;
    const lines = summary.totalLinesAdded + summary.totalLinesRemoved;
    return `${status} ${summary.intent}: ${fileCount} files, ${lines} lines changed`;
  }

  /**
   * Standard bullet list summary
   */
  private static formatStandard(summary: TaskSummary): string {
    const lines: string[] = [];
    const status = summary.completed ? 'Completed' : 'Failed';

    lines.push(`${status}: ${summary.intent}`);
    lines.push(`  Files changed: ${summary.filesChanged.length}`);
    lines.push(`  Lines: +${summary.totalLinesAdded} -${summary.totalLinesRemoved}`);

    if (summary.issues.length > 0) {
      lines.push('  Issues:');
      for (const issue of summary.issues.slice(0, 5)) {
        const icon = issue.severity === 'error' ? '✗' : issue.severity === 'warning' ? '⚠' : 'ℹ';
        lines.push(`    ${icon} ${issue.message}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Detailed summary with full file list
   */
  private static formatDetailed(summary: TaskSummary): string {
    const lines: string[] = [];
    const status = summary.completed ? 'Completed' : 'Failed';

    lines.push(`${status}: ${summary.intent}`);
    lines.push(`Duration: ${(summary.durationMs / 1000).toFixed(1)}s`);
    lines.push('');
    lines.push('Files changed:');

    for (const file of summary.filesChanged) {
      const icon = file.changeType === 'added' ? '+' : file.changeType === 'deleted' ? '-' : '~';
      lines.push(`  ${icon} ${file.path}`);
      lines.push(`     +${file.linesAdded} -${file.linesRemoved}`);
    }

    lines.push('');
    lines.push(`Total: +${summary.totalLinesAdded} -${summary.totalLinesRemoved}`);

    if (summary.rollbackAvailable) {
      lines.push('');
      lines.push('Rollback: Available via `jackcode rollback`');
    }

    return lines.join('\n');
  }

  /**
   * Map verification severity to summary severity
   */
  private static mapSeverity(severity: IssueSeverity): SummaryIssue['severity'] {
    switch (severity) {
      case 'critical':
      case 'high':
        return 'error';
      case 'medium':
        return 'warning';
      case 'low':
      default:
        return 'info';
    }
  }
}

// =============================================================================
// Approval Controller
// =============================================================================

/**
 * Evaluates operations and determines approval requirements
 */
export class ApprovalController {
  private rules: ApprovalRule[];

  constructor(rules: ApprovalRule[] = DEFAULT_APPROVAL_RULES) {
    this.rules = [...rules];
  }

  /**
   * Add custom approval rule
   */
  addRule(rule: ApprovalRule): void {
    this.rules.push(rule);
  }

  /**
   * Evaluate operation against rules
   */
  evaluate(
    operation: {
      files: FileChangeSummary[];
      riskLevel?: RiskLevel;
      workspacePath: string;
    },
    userOverrides?: { autoApprove?: boolean; autoReject?: string[] }
  ): ApprovalDecision {
    const { files, riskLevel = 'low', workspacePath } = operation;

    // User overrides take precedence
    if (userOverrides?.autoApprove) {
      return {
        requiresApproval: false,
        action: 'auto',
        reason: 'User auto-approval enabled',
      };
    }

    // Check for blocked patterns first
    for (const rule of this.rules) {
      if (rule.action === 'block' && this.matchesCondition(rule.condition, files, riskLevel, workspacePath)) {
        return {
          requiresApproval: true,
          action: 'block',
          reason: rule.name,
        };
      }
    }

    // Check for prompt rules
    const matchingPromptRules: ApprovalRule[] = [];
    for (const rule of this.rules) {
      if (rule.action === 'prompt' && this.matchesCondition(rule.condition, files, riskLevel, workspacePath)) {
        matchingPromptRules.push(rule);
      }
    }

    if (matchingPromptRules.length > 0) {
      return {
        requiresApproval: true,
        action: 'prompt',
        reason: matchingPromptRules.map((r) => r.name).join(', '),
        prompt: this.buildPrompt(files, riskLevel, matchingPromptRules),
      };
    }

    // No rules triggered - auto-approve
    return {
      requiresApproval: false,
      action: 'auto',
      reason: 'No approval rules triggered',
    };
  }

  /**
   * Check if condition matches operation
   */
  private matchesCondition(
    condition: ApprovalCondition,
    files: FileChangeSummary[],
    riskLevel: RiskLevel,
    workspacePath: string
  ): boolean {
    switch (condition.type) {
      case 'file_count':
        return files.length > condition.threshold;

      case 'file_pattern': {
        const patterns = condition.patterns;
        return files.some((f) =>


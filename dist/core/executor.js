/**
 * Thread 17: Executor with Developer Workflow UX
 * Qwen-first execution workflow, summary output, and approval boundaries
 */
import path from 'node:path';
/** Default configuration */
export const DEFAULT_PRESENTER_CONFIG = {
    format: 'detailed',
    showTimestamps: true,
    showProgressBar: true,
    maxContextLines: 3,
    colorize: true,
    indentSize: 2,
};
/** Default approval rules */
export const DEFAULT_APPROVAL_RULES = [
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
    config;
    constructor(config = {}) {
        this.config = { ...DEFAULT_PRESENTER_CONFIG, ...config };
    }
    /**
     * Render current workflow state
     */
    render(state) {
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
    renderCompact(state) {
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
    renderDetailed(state) {
        const lines = [];
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
    renderStep(step, indent, depth) {
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
    getStatusIcon(status) {
        const icons = {
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
    static create(patchResult, verification, options = {}) {
        const intent = options.intent || 'Task';
        const filesChanged = [];
        let totalLinesAdded = 0;
        let totalLinesRemoved = 0;
        // Summarize applied patches
        for (const patch of patchResult.applied) {
            const fileChange = {
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
        const issues = [];
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
            executionBrief: options.executionBrief,
            verificationBrief: options.verificationBrief,
            iterations: options.iterations,
        };
    }
    /**
     * Format summary as string
     */
    static format(summary, level = 'standard') {
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
    static formatBrief(summary) {
        const status = summary.completed ? '✓' : '✗';
        const fileCount = summary.filesChanged.length;
        const lines = summary.totalLinesAdded + summary.totalLinesRemoved;
        return `${status} ${summary.intent}: ${fileCount} files, ${lines} lines changed`;
    }
    /**
     * Standard bullet list summary
     */
    static formatStandard(summary) {
        const lines = [];
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
    static formatDetailed(summary) {
        const lines = [];
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
    static mapSeverity(severity) {
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
    rules;
    constructor(rules = DEFAULT_APPROVAL_RULES) {
        this.rules = [...rules];
    }
    /**
     * Add custom approval rule
     */
    addRule(rule) {
        this.rules.push(rule);
    }
    /**
     * Evaluate operation against rules
     */
    evaluate(operation, userOverrides) {
        const { files, riskLevel = 'low', workspacePath } = operation;
        // User overrides take precedence
        if (userOverrides?.autoApprove) {
            return {
                requiresApproval: false,
                action: 'auto',
                reason: 'User auto-approval enabled',
            };
        }
        if (userOverrides?.autoReject?.length) {
            const rejectedPaths = new Set(userOverrides.autoReject);
            const rejectedFile = files.find((file) => rejectedPaths.has(file.path));
            if (rejectedFile) {
                return {
                    requiresApproval: true,
                    action: 'block',
                    reason: `User rejected changes to ${rejectedFile.path}`,
                };
            }
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
        const matchingPromptRules = [];
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
    matchesCondition(condition, files, riskLevel, workspacePath) {
        switch (condition.type) {
            case 'file_count':
                return files.length > condition.threshold;
            case 'file_pattern': {
                const patterns = condition.patterns;
                return files.some((f) => patterns.some((p) => this.matchGlob(f.path, p)));
            }
            case 'risk_level': {
                const levels = ['low', 'medium', 'high', 'critical'];
                const operationLevel = levels.indexOf(riskLevel);
                const thresholdLevel = levels.indexOf(condition.level);
                return operationLevel >= thresholdLevel;
            }
            case 'deletion_count': {
                const totalDeletions = files.reduce((sum, f) => sum + f.linesRemoved, 0);
                return totalDeletions > condition.threshold;
            }
            case 'lines_changed': {
                const totalLines = files.reduce((sum, f) => sum + f.linesAdded + f.linesRemoved, 0);
                return totalLines > condition.threshold;
            }
            case 'outside_workspace': {
                if (!condition.enabled)
                    return false;
                const normalizedWorkspace = path.resolve(workspacePath);
                return files.some((file) => {
                    const candidatePath = path.isAbsolute(file.path)
                        ? path.resolve(file.path)
                        : path.resolve(normalizedWorkspace, file.path);
                    const relativePath = path.relative(normalizedWorkspace, candidatePath);
                    return relativePath.startsWith('..') || path.isAbsolute(relativePath);
                });
            }
            default:
                return false;
        }
    }
    /**
     * Simple glob matching
     */
    matchGlob(filePath, pattern) {
        const escapedPattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regex = new RegExp('^' + escapedPattern.replace(/\\\*/g, '.*').replace(/\\\?/g, '.') + '$');
        return regex.test(filePath);
    }
    /**
     * Build approval prompt from matching rules
     */
    buildPrompt(files, riskLevel, rules) {
        const changes = files.map((f) => ({
            path: f.path,
            changeType: f.changeType,
            linesAdded: f.linesAdded,
            linesRemoved: f.linesRemoved,
        }));
        const totalLines = files.reduce((sum, f) => sum + f.linesAdded + f.linesRemoved, 0);
        const fileCount = files.length;
        return {
            title: 'Approval Required',
            description: `This operation will modify ${fileCount} files (${totalLines} lines changed).\n\n` +
                `Triggered rules: ${rules.map((r) => r.name).join(', ')}`,
            changes,
            riskLevel,
            estimatedImpact: `${fileCount} files, +${files.reduce((sum, f) => sum + f.linesAdded, 0)} -${files.reduce((sum, f) => sum + f.linesRemoved, 0)} lines`,
        };
    }
}
// =============================================================================
// Executor Integration
// =============================================================================
/**
 * Main executor class integrating workflow UX components
 */
export class WorkflowExecutor {
    presenter;
    approval;
    constructor(presenterConfig, approvalRules) {
        this.presenter = new WorkflowPresenter(presenterConfig);
        this.approval = new ApprovalController(approvalRules);
    }
    /**
     * Execute with full workflow UX
     */
    async execute(task, operation, options) {
        // Build initial workflow state
        const state = {
            sessionId: task.id,
            intent: task.intent,
            steps: [
                { id: '1', label: 'Planning', status: 'completed' },
                { id: '2', label: 'Executing', status: 'running', startTime: Date.now() },
                { id: '3', label: 'Verifying', status: 'pending' },
            ],
            currentStepId: '2',
            startTime: Date.now(),
            executionBrief: options.executionBrief,
            verificationBrief: options.verificationBrief,
        };
        try {
            const { patchResult, verification, executionBrief, verificationBrief, failureDossier, iterations } = await operation();
            state.steps[1].status = patchResult.success ? 'completed' : 'failed';
            state.steps[1].endTime = Date.now();
            state.steps[2].status = verification ? 'running' : 'skipped';
            state.steps[2].startTime = verification ? Date.now() : undefined;
            state.currentStepId = verification ? '3' : undefined;
            state.executionBrief = executionBrief ?? state.executionBrief;
            state.verificationBrief = verificationBrief ?? state.verificationBrief;
            state.failureDossier = failureDossier;
            const summary = SummaryGenerator.create(patchResult, verification, {
                level: 'standard',
                intent: task.intent,
                executionBrief: state.executionBrief,
                verificationBrief: state.verificationBrief,
                iterations,
            });
            const decision = this.approval.evaluate({
                files: summary.filesChanged,
                riskLevel: this.calculateRiskLevel(summary),
                workspacePath: options.workspacePath,
            });
            if (decision.action === 'block') {
                state.steps[2].status = 'failed';
                state.steps[2].endTime = Date.now();
                state.endTime = Date.now();
                return { approved: false, summary };
            }
            if (decision.requiresApproval) {
                if (!decision.prompt || !options.onApprovalRequest) {
                    state.steps[2].status = 'failed';
                    state.steps[2].endTime = Date.now();
                    state.endTime = Date.now();
                    return { approved: false, summary };
                }
                const approved = await options.onApprovalRequest(decision.prompt);
                if (!approved) {
                    state.steps[2].status = 'failed';
                    state.steps[2].endTime = Date.now();
                    state.endTime = Date.now();
                    return { approved: false, summary };
                }
            }
            state.steps[2].status = this.getVerificationStepStatus(verification?.decision);
            state.steps[2].endTime = Date.now();
            state.currentStepId = undefined;
            state.endTime = Date.now();
            return { approved: true, result: patchResult, summary };
        }
        catch (error) {
            state.steps[1].status = 'failed';
            state.steps[1].endTime = Date.now();
            state.steps[2].status = 'skipped';
            state.currentStepId = undefined;
            state.endTime = Date.now();
            throw error;
        }
    }
    getVerificationStepStatus(decision) {
        switch (decision) {
            case 'approve':
                return 'completed';
            case 'repair':
                return 'running';
            case 'reject':
                return 'failed';
            default:
                return 'skipped';
        }
    }
    /**
     * Render current workflow state
     */
    renderState(state) {
        return this.presenter.render(state);
    }
    /**
     * Calculate risk level from summary
     */
    calculateRiskLevel(summary) {
        const fileCount = summary.filesChanged.length;
        const totalLines = summary.totalLinesAdded + summary.totalLinesRemoved;
        const errorCount = summary.issues.filter((i) => i.severity === 'error').length;
        if (errorCount > 0 || totalLines > 500 || fileCount > 50)
            return 'critical';
        if (totalLines > 200 || fileCount > 20)
            return 'high';
        if (totalLines > 50 || fileCount > 5)
            return 'medium';
        return 'low';
    }
}
// Export singleton for convenience
export const workflowExecutor = new WorkflowExecutor();

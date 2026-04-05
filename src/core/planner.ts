/**
 * Pre-execution planning with DeepSeek-backed strategy selection.
 */

import type { TaskContext as RuntimeTaskContext, ExecutionPlan, PlanStep } from './runtime.js';
import type { ModelTier } from '../model/types/policy.js';
import type { ExecutionBrief, WorkflowRiskLevel } from '../types/workflow.js';
import type { DeepSeekReasonerRouter } from '../model/deepseek-router.js';
import type { RepairContext } from '../model/types/reasoning.js';
import type { CompressedContext } from '../types/context.js';

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export class WorkflowPlanner {
  constructor(private readonly deepseek?: DeepSeekReasonerRouter) {}

  async createExecutionBrief(
    task: RuntimeTaskContext,
    compressedContext?: CompressedContext
  ): Promise<ExecutionBrief> {
    const affectedFiles = this.extractAffectedFiles(task, compressedContext);
    const multiFile = affectedFiles.length > 1;
    const reasoningRequired = multiFile || task.attempts > 1 || /refactor|architecture|dependency|design/i.test(task.intent);
    const riskLevel = this.assessRisk(task, affectedFiles, reasoningRequired);
    const contextBudgetTokens = compressedContext?.stats.finalTokens ?? estimateTokens(task.intent);

    const deepseekHints = this.deepseek ? await this.safeAnalyze(task, compressedContext) : null;
    const selectedModel: ModelTier = reasoningRequired || riskLevel === 'critical' ? 'deepseek' : 'qwen';
    const steps = this.buildSteps(task, affectedFiles, deepseekHints?.planHints ?? []);

    return {
      taskId: task.id,
      intent: task.intent,
      strategy: reasoningRequired ? 'plan_then_execute' : 'direct_execute',
      selectedModel,
      escalationTarget: riskLevel === 'critical' ? 'gpt54' : undefined,
      contextBudgetTokens,
      reasoningRequired,
      multiFile,
      riskLevel,
      objectives: [task.intent],
      constraints: [
        'Prefer minimal safe changes',
        'Preserve public behavior unless intent explicitly changes it',
      ],
      assumptions: deepseekHints?.assumptions ?? [],
      affectedFiles,
      relatedTests: this.inferRelatedTests(affectedFiles),
      steps,
      successCriteria: [
        'Requested behavior implemented or repaired',
        'Relevant tests/build checks pass',
        'No obvious breaking changes introduced',
      ],
      createdAt: Date.now(),
      metadata: {
        deepseekEscalated: deepseekHints?.escalated ?? false,
        dossierSummary: deepseekHints?.summary,
      },
    };
  }

  toExecutionPlan(brief: ExecutionBrief): ExecutionPlan {
    const steps: PlanStep[] = brief.steps.map((step) => ({
      id: step.id,
      description: step.title,
      targetFiles: step.targetFiles,
      dependencies: step.dependencies ?? [],
    }));

    return {
      steps,
      estimatedTokens: Math.max(brief.contextBudgetTokens, brief.steps.length * 600),
      targetModel: brief.selectedModel,
    };
  }

  private assessRisk(task: RuntimeTaskContext, files: string[], reasoningRequired: boolean): WorkflowRiskLevel {
    if (task.routePriority === 'critical' || /architecture|migration|breaking/i.test(task.intent)) return 'critical';
    if (files.length >= 4 || reasoningRequired) return 'high';
    if (files.length >= 2 || task.attempts > 1) return 'medium';
    return 'low';
  }

  private extractAffectedFiles(task: RuntimeTaskContext, compressedContext?: CompressedContext): string[] {
    const files = new Set<string>();

    task.plan?.steps.forEach((step) => step.targetFiles.forEach((file) => files.add(file)));
    task.artifacts.forEach((artifact) => {
      if (/\.(ts|tsx|js|jsx|json|md)$/i.test(artifact.path)) files.add(artifact.path);
    });

    const text = [task.intent, compressedContext?.content ?? ''].join('\n');
    const matches = text.match(/([\w./-]+\.(?:ts|tsx|js|jsx|json|md))/g) ?? [];
    matches.forEach((file) => files.add(file));

    return [...files].slice(0, 12);
  }

  private inferRelatedTests(files: string[]): string[] {
    return files
      .filter((file) => !/(\.test\.|\.spec\.|__tests__)/i.test(file))
      .flatMap((file) => {
        const stem = file.replace(/\.(ts|tsx|js|jsx)$/i, '');
        return [`${stem}.test.ts`, `${stem}.spec.ts`];
      })
      .slice(0, 12);
  }

  private buildSteps(task: RuntimeTaskContext, files: string[], hints: string[]) {
    const primaryFiles = files.length > 0 ? files : ['unknown'];
    return [
      {
        id: `${task.id}-plan-1`,
        title: 'Review impacted code surface',
        action: 'inspect',
        targetFiles: primaryFiles,
        rationale: hints[0] ?? 'Start from the most likely impacted files and interfaces.',
        verificationHint: 'Confirm file ownership and public contracts before editing.',
      },
      {
        id: `${task.id}-plan-2`,
        title: 'Apply focused implementation changes',
        action: 'edit',
        targetFiles: primaryFiles,
        dependencies: [`${task.id}-plan-1`],
        rationale: hints[1] ?? 'Prefer minimal safe edits over broad rewrites.',
        verificationHint: 'Preserve imports, signatures, and expected caller behavior.',
      },
      {
        id: `${task.id}-plan-3`,
        title: 'Validate behavior with targeted checks',
        action: 'verify',
        targetFiles: this.inferRelatedTests(primaryFiles),
        dependencies: [`${task.id}-plan-2`],
        rationale: hints[2] ?? 'Run or reason about the narrowest relevant validation first.',
        verificationHint: 'Check tests, type safety, and regressions around changed code.',
      },
    ];
  }

  private async safeAnalyze(task: RuntimeTaskContext, compressedContext?: CompressedContext): Promise<{
    escalated: boolean;
    summary: string;
    assumptions: string[];
    planHints: string[];
  } | null> {
    try {
      const repairContext: RepairContext = {
        taskId: task.id,
        errors: task.errors,
        artifacts: task.artifacts,
        context: compressedContext,
        attemptNumber: Math.max(task.attempts, 1),
        maxAttempts: Math.max(task.maxAttempts, 1),
        intent: task.intent,
      };
      const packet = this.deepseek?.createHandoffPacket(repairContext);
      return packet
        ? {
            escalated: packet.shouldEscalate,
            summary: packet.summary,
            assumptions: packet.hypotheses.map((item) => item.hypothesis),
            planHints: packet.planSteps,
          }
        : null;
    } catch {
      return null;
    }
  }
}

export const workflowPlanner = new WorkflowPlanner();

/**
 * Pre-execution planning with Qwen-first strategy selection.
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}
export class WorkflowPlanner {
    async createExecutionBrief(task, compressedContext) {
        const affectedFiles = this.extractAffectedFiles(task, compressedContext);
        const multiFile = affectedFiles.length > 1;
        const reasoningRequired = multiFile || task.attempts > 1 || /refactor|architecture|dependency|design/i.test(task.intent);
        const riskLevel = this.assessRisk(task, affectedFiles, reasoningRequired);
        const contextBudgetTokens = compressedContext?.stats.finalTokens ?? estimateTokens(task.intent);
        const selectedModel = task.state === 'reviewing' ? 'gpt54' : 'qwen';
        const assumptions = reasoningRequired
            ? ['Qwen 3.6 should handle implementation planning directly without escalation.']
            : [];
        const steps = this.buildSteps(task, affectedFiles, []);
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
            assumptions,
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
                plannerModel: 'qwen',
                auditModel: 'gpt54',
            },
        };
    }
    toExecutionPlan(brief) {
        const steps = brief.steps.map((step) => ({
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
    assessRisk(task, files, reasoningRequired) {
        if (task.routePriority === 'critical' || /architecture|migration|breaking/i.test(task.intent))
            return 'critical';
        if (files.length >= 4 || reasoningRequired)
            return 'high';
        if (files.length >= 2 || task.attempts > 1)
            return 'medium';
        return 'low';
    }
    extractAffectedFiles(task, compressedContext) {
        const files = new Set();
        task.plan?.steps.forEach((step) => step.targetFiles.forEach((file) => files.add(file)));
        task.artifacts.forEach((artifact) => {
            if (/\.(ts|tsx|js|jsx|json|md)$/i.test(artifact.path))
                files.add(artifact.path);
        });
        const text = [task.intent, compressedContext?.content ?? ''].join('\n');
        const matches = text.match(/([\w./-]+\.(?:ts|tsx|js|jsx|json|md))/g) ?? [];
        matches.forEach((file) => files.add(file));
        return [...files].slice(0, 12);
    }
    inferRelatedTests(files) {
        return files
            .filter((file) => !/(\.test\.|\.spec\.|__tests__)/i.test(file))
            .flatMap((file) => {
            const stem = file.replace(/\.(ts|tsx|js|jsx)$/i, '');
            return [`${stem}.test.ts`, `${stem}.spec.ts`];
        })
            .slice(0, 12);
    }
    buildSteps(task, files, hints) {
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
}
export const workflowPlanner = new WorkflowPlanner();

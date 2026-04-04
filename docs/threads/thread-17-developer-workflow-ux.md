# Thread 17: Developer Workflow UX

## Overview

Design for human-friendly workflow presentation, summary output generation, and approval boundaries in JackCode.

## Goals

1. **Clear Workflow Visualization**: Present execution progress in a way developers can understand at a glance
2. **Actionable Summaries**: Generate concise, useful summaries of what was done
3. **Smart Approval Boundaries**: Know when to ask for human approval vs auto-execute

## Core Components

### 1. Workflow Presentation (`WorkflowPresenter`)

**Responsibilities:**
- Render execution state visually (progress bars, status indicators)
- Group related operations into logical steps
- Show estimated vs actual time
- Display file changes with context

**Key Features:**
```typescript
interface WorkflowPresenterConfig {
  format: 'compact' | 'detailed' | 'json';
  showTimestamps: boolean;
  showProgressBar: boolean;
  maxContextLines: number;
  colorize: boolean;
}
```

**Output Formats:**
- **Compact**: Single-line status per operation
- **Detailed**: Full context with file diffs preview
- **JSON**: Machine-readable for CI/CD integration

### 2. Summary Output (`SummaryGenerator`)

**Responsibilities:**
- Summarize completed tasks
- Highlight important changes
- List modified files with impact
- Provide rollback instructions

**Summary Levels:**
- **Brief**: 1-2 lines, suitable for commit messages
- **Standard**: Bullet list of changes with rationale
- **Detailed**: Full report with metrics and warnings

### 3. Approval Boundaries (`ApprovalController`)

**Responsibilities:**
- Evaluate operation risk level
- Determine if approval required
- Present clear approval prompts
- Track approval decisions

**Approval Triggers:**
```typescript
interface ApprovalRule {
  id: string;
  name: string;
  condition: ApprovalCondition;
  action: 'auto' | 'prompt' | 'block';
}

type ApprovalCondition =
  | { type: 'file_count'; threshold: number }
  | { type: 'file_pattern'; patterns: string[] }
  | { type: 'risk_level'; level: 'low' | 'medium' | 'high' | 'critical' }
  | { type: 'deletion_count'; threshold: number }
  | { type: 'outside_workspace'; enabled: boolean };
```

## Default Approval Rules

| Rule | Condition | Action |
|------|-----------|--------|
| Safe Files | ≤5 files, low risk | Auto |
| Moderate Changes | 6-20 files or medium risk | Prompt |
| Bulk Changes | >20 files | Prompt with summary |
| Deletions | >10 lines deleted | Prompt |
| Config Files | `*.config.*`, `.env*` | Prompt |
| Outside Workspace | Any file outside cwd | Block |
| Tests Modified | `*test*` files changed | Auto |

## Workflow State Visualization

```
JackCode Session: feat/add-auth-module
├── Planning... ✓ (1.2s)
├── Executing... ✓ (4.5s)
│   ├── src/auth/login.ts [modified +45 -12]
│   ├── src/auth/guard.ts [created +89]
│   └── tests/auth.test.ts [modified +23 -5]
├── Verifying... ✓ (2.1s)
│   └── All checks passed
└── Complete ✓ (7.8s)

Summary: 3 files changed, +157 lines, -17 lines
```

## API Surface

```typescript
// Present workflow state
const presenter = new WorkflowPresenter(config);
presenter.render(sessionState);

// Generate summary
const summary = SummaryGenerator.create(taskResult, { level: 'standard' });

// Check approval
const decision = await ApprovalController.evaluate(operation, rules);
if (decision.requiresApproval) {
  const approved = await promptUser(decision.prompt);
}
```

## Integration Points

- **Thread 01 (Runtime)**: Hooks for state change events
- **Thread 11 (Reviewer)**: Receives verification results for summary
- **CLI**: Formatted output to stdout/stderr
- **JackClaw Adapter**: Structured output for IDE integration

## Success Metrics

- Developer can understand task status in <5 seconds
- Approval prompts are clear and actionable
- Summaries are accurate and complete
- False positive approval rate <10%

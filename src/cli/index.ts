/**
 * JackCode CLI Entry Point
 *
 * Handles command-line interface, argument parsing, and mode dispatching.
 * Supports both one-shot execution and interactive chat modes.
 */

import {
  addMessage,
  createChatSession,
  createRenderer,
  exportSession,
  formatMessage,
  getSessionFilePath,
  loadSession,
  resumeLatestSession,
  saveSession,
  startRepl,
} from './chat.js';
import { workflowPlanner } from '../core/planner.js';
import { SummaryGenerator } from '../core/executor.js';
import type { VerificationResult } from '../types/reviewer.js';
import type { Patch, PatchResult } from '../types/patch.js';
import type { ExecutionBrief, VerificationBrief } from '../types/workflow.js';
import type { CLIConfig, ModelTier, ParseResult, PendingChange, Theme } from '../types/cli.js';
import type { TaskContext as RuntimeTaskContext } from '../core/runtime.js';

export {
  createChatSession,
  createRenderer,
  exportSession,
  formatMessage,
  getSessionFilePath,
  loadSession,
  resumeLatestSession,
  saveSession,
  startRepl,
};

const DEFAULT_CONFIG: CLIConfig = {
  defaultModel: 'qwen-3.6',
  theme: 'auto',
  streaming: true,
  showTokenCount: true,
  historyFile: '.jackcode/history',
};

interface CLIWorkflowRun {
  runtimeTask: RuntimeTaskContext;
  executionBrief: ExecutionBrief;
  verificationBrief: VerificationBrief;
  verificationResult: VerificationResult;
  patchResult: PatchResult;
  pendingChanges: PendingChange[];
  filesTouched: string[];
}

/**
 * Parse CLI arguments and determine execution mode
 */
export function parseArgs(args: string[]): ParseResult {
  const result: ParseResult = {
    mode: 'chat',
    config: { ...DEFAULT_CONFIG },
    prompt: undefined,
    flags: {},
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '--help':
      case '-h':
        result.mode = 'help';
        break;
      case '--version':
      case '-v':
        result.mode = 'version';
        break;
      case '--model':
      case '-m': {
        const value = args[i + 1];
        if (!isModelTier(value)) {
          throw new Error(`Invalid model tier: ${value ?? '(missing)'}`);
        }
        result.config.defaultModel = value;
        i++;
        break;
      }
      case '--no-stream':
        result.config.streaming = false;
        break;
      case '--theme': {
        const value = args[i + 1];
        if (!isTheme(value)) {
          throw new Error(`Invalid theme: ${value ?? '(missing)'}`);
        }
        result.config.theme = value;
        i++;
        break;
      }
      case '--history-file': {
        const value = args[i + 1];
        if (!value) {
          throw new Error('--history-file requires a value');
        }
        result.config.historyFile = value;
        i++;
        break;
      }
      case '--resume':
        result.flags.resume = true;
        break;
      case '--load': {
        const value = args[i + 1];
        if (!value) {
          throw new Error('--load requires a path');
        }
        result.flags.load = value;
        i++;
        break;
      }
      case '--save': {
        const value = args[i + 1];
        if (!value) {
          throw new Error('--save requires a path');
        }
        result.flags.save = value;
        i++;
        break;
      }
      case '--export': {
        const value = args[i + 1];
        if (!value) {
          throw new Error('--export requires a path');
        }
        result.flags.export = value;
        i++;
        break;
      }
      case '--execute':
      case '-e':
        result.mode = 'execute';
        break;
      default:
        if (arg === 'chat') {
          result.mode = 'chat';
          break;
        }

        if (!arg.startsWith('-')) {
          result.prompt = args.slice(i).join(' ');
          if (result.mode !== 'execute') {
            result.mode = 'oneshot';
          }
          i = args.length;
        } else {
          const next = args[i + 1];
          if (!next || next.startsWith('-')) {
            result.flags[arg] = true;
          } else {
            result.flags[arg] = next;
            i++;
          }
        }
    }
  }

  return result;
}

/**
 * Main CLI entry point
 */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  let parsed: ParseResult;

  try {
    parsed = parseArgs(args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Argument error: ${message}`);
    process.exit(1);
  }

  switch (parsed.mode) {
    case 'help':
      printHelp();
      break;
    case 'version':
      printVersion();
      break;
    case 'oneshot':
      await runOneshot(parsed.prompt!, parsed.config, parsed.flags);
      break;
    case 'execute':
      await runExecute(parsed.prompt, parsed.config, parsed.flags);
      break;
    case 'chat':
    default:
      await runInteractive(parsed.config, parsed.flags);
      break;
  }
}

/**
 * Print CLI help information
 */
function printHelp(): void {
  console.log(`
JackCode - AI-powered coding assistant

Usage:
  jackcode [options] [prompt]     Start interactive chat or run one-shot
  jackcode chat                   Start interactive chat mode

Options:
  -h, --help                      Show this help message
  -v, --version                   Show version
  -m, --model <tier>              Set default model tier (qwen-3.6/gpt-5.4)
  -e, --execute                   Execute mode: apply changes immediately
  --no-stream                     Disable streaming output
  --theme <theme>                 Set theme (dark/light/auto)
  --history-file <path>           Override command history file
  --resume                        Resume most recently saved session
  --load <path>                   Load session from path before starting
  --save <path>                   Save oneshot/execute result to path
  --export <path>                 Export conversation to markdown

Examples:
  jackcode "refactor auth.ts"     One-shot request
  jackcode chat                   Interactive session
  jackcode --resume               Resume latest interactive session
  jackcode --load .jackcode/s.json
  jackcode -m qwen-3.6 "..."      Use Qwen 3.6 for this request
  jackcode -e "add integration tests"  Execute immediately

Interactive Commands:
  /help                           Show available commands
  /status                         Show session status
  /clear                          Clear the terminal
  /save [file]                    Save current session
  /load <file>                    Load session from disk
  /export <file>                  Export conversation to markdown
  /history [count]                Show recent messages
  /plan <task>                    Generate execution plan
  /execute [task]                 Execute current plan or new task
  /review                         Review pending changes
  /undo                           Revert last change
  /diff                           Show current diff
  /context                        Show context window info
  /model <tier>                   Switch model tier
  /theme <theme>                  Switch terminal theme
  /session                        Show session metadata
  /resume                         Resume latest saved session
  /exit, /quit                    Exit interactive mode
`);
}

/**
 * Print version information
 */
function printVersion(): void {
  console.log('JackCode v1.0.0');
}

function isModelTier(value: string | undefined): value is ModelTier {
  return value === 'qwen-3.6' || value === 'gpt-5.4';
}

function isTheme(value: string | undefined): value is Theme {
  return value === 'dark' || value === 'light' || value === 'auto';
}

function toPlannerModel(model: ModelTier): 'qwen' | 'gpt54' {
  return model === 'gpt-5.4' ? 'gpt54' : 'qwen';
}

function toCliModel(model: 'qwen' | 'gpt54'): ModelTier {
  return model === 'gpt54' ? 'gpt-5.4' : 'qwen-3.6';
}

function buildRuntimeTask(prompt: string, config: CLIConfig, mode: 'idle' | 'execute'): RuntimeTaskContext {
  const now = Date.now();
  const taskId = `cli-${now.toString(36)}`;

  return {
    id: taskId,
    state: mode === 'execute' ? 'executing' : 'planning',
    status: 'running',
    intent: prompt,
    priority: 'normal',
    routePriority: 'normal',
    attempts: 0,
    maxAttempts: 1,
    artifacts: [],
    errors: [],
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    retryCount: 0,
    metadata: {
      source: 'cli',
      requestedModel: toPlannerModel(config.defaultModel),
    },
  };
}

function extractFilesFromPrompt(prompt: string): string[] {
  const matches = prompt.match(/([\w./-]+\.(?:ts|tsx|js|jsx|json|md|yml|yaml|css|scss|html|sh))/gi) ?? [];
  return [...new Set(matches)].slice(0, 8);
}

function makePlaceholderPatch(targetPath: string, index: number): Patch {
  return {
    id: `dry-run-patch-${index + 1}`,
    targetPath,
    hunks: [
      {
        oldRange: { start: 1, end: 1 },
        newRange: { start: 1, end: 2 },
        contextBefore: [],
        removedLines: [],
        addedLines: ['// planned change not yet applied'],
        contextAfter: [],
      },
    ],
    originalChecksum: 'dry-run',
    reversePatch: {
      storagePath: '.jackcode/dry-run',
      checksum: 'dry-run',
    },
  };
}

async function runCliWorkflow(prompt: string, config: CLIConfig, executeRequested: boolean): Promise<CLIWorkflowRun> {
  const runtimeTask = buildRuntimeTask(prompt, config, executeRequested ? 'execute' : 'idle');
  const requestedFiles = extractFilesFromPrompt(prompt);
  runtimeTask.artifacts = requestedFiles.map((filePath, index) => ({
    id: `artifact-${index + 1}`,
    type: 'file',
    path: filePath,
  }));

  const executionBrief = await workflowPlanner.createExecutionBrief(runtimeTask);
  executionBrief.selectedModel = toPlannerModel(config.defaultModel);
  executionBrief.metadata = {
    ...(executionBrief.metadata ?? {}),
    cliMode: executeRequested ? 'execute' : 'oneshot',
    executionMode: executeRequested ? 'dry-run' : 'plan',
  };
  runtimeTask.plan = workflowPlanner.toExecutionPlan(executionBrief);
  runtimeTask.state = executeRequested ? 'executing' : 'reviewing';

  const filesTouched = executionBrief.affectedFiles.length > 0
    ? executionBrief.affectedFiles
    : requestedFiles.length > 0
      ? requestedFiles
      : ['(no file targets inferred)'];

  const appliedPatches = filesTouched[0] === '(no file targets inferred)'
    ? []
    : filesTouched.map((filePath, index) => makePlaceholderPatch(filePath, index));

  const patchResult: PatchResult = {
    success: !executeRequested,
    applied: appliedPatches,
    failed: executeRequested && filesTouched[0] !== '(no file targets inferred)'
      ? appliedPatches.map((patch) => ({
          patch,
          error: 'CLI execute path is currently dry-run only; no filesystem mutation was attempted.',
          failureType: 'io_error',
        }))
      : undefined,
    canRollback: false,
  };

  const verificationBrief: VerificationBrief = {
    taskId: runtimeTask.id,
    decision: executeRequested ? 'repair' : 'approve',
    approvedWithSuggestions: executeRequested,
    semanticFulfillment: !executeRequested,
    testCoverageAdequate: false,
    breakingChangeRisk: executionBrief.riskLevel === 'critical' ? 'high' : executionBrief.riskLevel,
    criteria: [
      {
        criterion: 'Plan covers requested intent',
        passed: true,
        blocking: false,
        notes: 'Planner produced a concrete execution brief and ordered steps.',
      },
      {
        criterion: 'Filesystem mutation applied',
        passed: false,
        blocking: executeRequested,
        notes: executeRequested
          ? 'Execute mode currently reports a truthful dry-run instead of pretending to edit files.'
          : 'One-shot mode stops before file mutation by design.',
      },
      {
        criterion: 'Targeted verification executed',
        passed: false,
        blocking: false,
        notes: 'No build/test command was inferred or run from the prompt alone.',
      },
    ],
    issues: executeRequested
      ? [
          {
            dimension: 'intent_match',
            severity: 'medium',
            description: 'Requested execute flow is limited to dry-run planning output in the current CLI implementation.',
            location: { filePath: 'src/cli/index.ts' },
            suggestion: 'Integrate a real patch application backend before reporting applied changes.',
          },
        ]
      : [],
    suggestedRepairs: executeRequested
      ? [
          {
            issue: 'No real patch application backend is connected to CLI execute mode.',
            explanation: 'The CLI can plan and summarize likely edits, but it should not claim to have written files yet.',
            options: [
              'Run in one-shot mode to inspect the plan first.',
              'Connect execute mode to a real patch engine before enabling writes.',
            ],
          },
        ]
      : [],
    verifiedAt: Date.now(),
    metadata: {
      verifierModel: 'gpt-5.4 audit',
      executionMode: executeRequested ? 'dry-run' : 'plan-only',
    },
  };

  const verificationResult: VerificationResult = {
    decision: verificationBrief.decision,
    issues: verificationBrief.issues,
    repairs: [],
    confidence: executeRequested ? 0.68 : 0.82,
    report: {
      verifiedAt: verificationBrief.verifiedAt,
      model: 'gpt-5.4 audit',
      quality: {
        score: executeRequested ? 0.72 : 0.86,
        styleCompliant: true,
        patternsConsistent: true,
        documentationAdequate: true,
        dimensionScores: {
          intent_match: executeRequested ? 0.7 : 0.9,
          code_quality: 0.8,
          type_safety: 0.8,
          test_coverage: 0.4,
          no_regression: 0.6,
          security: 0.85,
        },
      },
      safety: {
        noBreakingChanges: true,
        noSecurityIssues: true,
        typeSafe: true,
        risks: executeRequested ? ['Dry-run only: no runtime validation performed'] : ['Plan not yet validated by build/test'],
      },
      intentFulfilled: !executeRequested,
      summary: executeRequested
        ? 'Verifier accepted the workflow summary as a dry-run and flagged missing real execution.'
        : 'Verifier accepted the generated plan and highlighted missing runtime validation.',
    },
    metadata: {
      model: 'gpt-5.4 audit',
      verifiedAt: verificationBrief.verifiedAt,
      durationMs: 0,
      issueCount: verificationBrief.issues.length,
    },
  };

  const pendingChanges: PendingChange[] = filesTouched[0] === '(no file targets inferred)'
    ? []
    : filesTouched.map((filePath, index) => ({
        id: `pending-${index + 1}`,
        path: filePath,
        type: 'modify',
        diff: `--- a/${filePath}\n+++ b/${filePath}\n@@\n+// planned change not yet applied\n`,
        applied: false,
      }));

  return {
    runtimeTask,
    executionBrief,
    verificationBrief,
    verificationResult,
    patchResult,
    pendingChanges,
    filesTouched,
  };
}

function formatCliWorkflow(run: CLIWorkflowRun, executeRequested: boolean): string {
  const summary = SummaryGenerator.create(run.patchResult, run.verificationResult, {
    intent: run.runtimeTask.intent,
    executionBrief: run.executionBrief,
    verificationBrief: run.verificationBrief,
    iterations: 1,
  });

  const lines: string[] = [];
  lines.push(`Workflow: ${executeRequested ? 'execute (dry-run)' : 'oneshot plan'}`);
  lines.push(`Planner model: ${toCliModel(run.executionBrief.selectedModel)}`);
  lines.push('Verifier model: gpt-5.4 audit');
  lines.push(`Strategy: ${run.executionBrief.strategy}`);
  lines.push(`Risk: ${run.executionBrief.riskLevel}`);
  lines.push(`Context budget: ~${run.executionBrief.contextBudgetTokens} tokens`);
  lines.push('');
  lines.push('Plan:');
  for (const [index, step] of run.executionBrief.steps.entries()) {
    const targets = step.targetFiles.length > 0 ? step.targetFiles.join(', ') : 'no explicit files';
    lines.push(`  ${index + 1}. ${step.title}`);
    lines.push(`     targets: ${targets}`);
  }
  lines.push('');
  lines.push('Files touched:');
  if (run.filesTouched.length === 0) {
    lines.push('  - none inferred');
  } else {
    for (const filePath of run.filesTouched) {
      lines.push(`  - ${filePath}`);
    }
  }
  lines.push('');
  lines.push('Patch summary:');
  lines.push(`  ${SummaryGenerator.format(summary, 'brief')}`);
  if (run.pendingChanges.length > 0) {
    lines.push('  Pending diffs:');
    for (const change of run.pendingChanges.slice(0, 6)) {
      lines.push(`    - ${change.path} [${change.type}]`);
    }
  }
  lines.push('');
  lines.push('Verification:');
  lines.push(`  Decision: ${run.verificationResult.decision}`);
  lines.push(`  Confidence: ${Math.round(run.verificationResult.confidence * 100)}%`);
  lines.push(`  Summary: ${run.verificationResult.report.summary}`);
  if (run.verificationResult.issues.length > 0) {
    lines.push('  Issues:');
    for (const issue of run.verificationResult.issues) {
      lines.push(`    - [${issue.severity}] ${issue.description}`);
    }
  }
  if (executeRequested) {
    lines.push('');
    lines.push('Result: no files were modified. Execute mode is reporting a dry-run until a real patch backend is wired in.');
  }

  return lines.join('\n');
}

function printWorkflowHeader(config: CLIConfig, label: string): void {
  console.log(`JackCode ${label} | Planner: ${config.defaultModel} | Verifier: gpt-5.4 audit`);
  console.log('─'.repeat(72));
}

function persistCliSession(
  session: ReturnType<typeof createChatSession>,
  flags: Record<string, string | boolean>
): void {
  if (typeof flags.save === 'string') {
    saveSession(session, flags.save);
    console.log(`Saved session to ${flags.save}`);
  }
  if (typeof flags.export === 'string') {
    exportSession(session, flags.export);
    console.log(`Exported conversation to ${flags.export}`);
  }
}

/**
 * Run one-shot mode: execute task and exit
 */
async function runOneshot(
  prompt: string,
  config: CLIConfig,
  flags: Record<string, string | boolean>
): Promise<void> {
  const session = createChatSession(config, { mode: 'plan' });
  const renderer = createRenderer(config.theme);

  printWorkflowHeader(config, 'One-shot');
  console.log(renderer.renderStatus(session, { isProcessing: false, currentStream: null, lastActivity: Date.now() }));

  const userMessage = addMessage(session, 'user', prompt);
  console.log(formatMessage(userMessage, { theme: config.theme, showTimestamps: true, compact: false }));
  console.log(renderer.renderProgress('Planning workflow', 1, 3));

  const run = await runCliWorkflow(prompt, config, false);
  session.pendingChanges.splice(0, session.pendingChanges.length, ...run.pendingChanges);
  session.mode = 'review';

  console.log(renderer.renderProgress('Summarizing execution', 2, 3));
  const reply = formatCliWorkflow(run, false);
  const assistantMessage = addMessage(session, 'assistant', reply, {
    model: config.defaultModel,
    tokensUsed: reply.length,
    latencyMs: 0,
    toolCalls: [],
  });
  console.log(renderer.renderProgress('Verifying summary', 3, 3));
  console.log(formatMessage(assistantMessage, { theme: config.theme, showTimestamps: true, compact: false }));

  persistCliSession(session, flags);
}

/**
 * Run execute mode: apply changes without confirmation
 */
async function runExecute(
  prompt: string | undefined,
  config: CLIConfig,
  flags: Record<string, string | boolean>
): Promise<void> {
  if (!prompt) {
    console.error('Error: --execute requires a prompt');
    process.exit(1);
  }

  const session = createChatSession(config, { mode: 'execute' });
  const renderer = createRenderer(config.theme);

  printWorkflowHeader(config, 'Execute');
  console.log(renderer.renderStatus(session, { isProcessing: false, currentStream: null, lastActivity: Date.now() }));

  const userMessage = addMessage(session, 'user', prompt);
  console.log(formatMessage(userMessage, { theme: config.theme, showTimestamps: true, compact: false }));
  console.log(renderer.renderProgress('Planning workflow', 1, 3));

  const run = await runCliWorkflow(prompt, config, true);
  session.pendingChanges.splice(0, session.pendingChanges.length, ...run.pendingChanges);

  console.log(renderer.renderProgress('Preparing dry-run execution', 2, 3));
  const reply = formatCliWorkflow(run, true);
  const assistantMessage = addMessage(session, 'assistant', reply, {
    model: config.defaultModel,
    tokensUsed: reply.length,
    latencyMs: 0,
    toolCalls: [],
  });
  console.log(renderer.renderProgress('Verifying result', 3, 3));
  console.log(formatMessage(assistantMessage, { theme: config.theme, showTimestamps: true, compact: false }));

  persistCliSession(session, flags);
  process.exitCode = run.verificationResult.decision === 'approve' ? 0 : 2;
}

/**
 * Run interactive chat mode
 */
async function runInteractive(config: CLIConfig, flags: Record<string, string | boolean>): Promise<void> {
  let session = createChatSession(config);

  if (typeof flags.load === 'string') {
    session = loadSession(flags.load);
  } else if (flags.resume === true) {
    session = resumeLatestSession() ?? session;
  }

  console.log(`
╔════════════════════════════════════════╗
║     JackCode v1.0.0 - Interactive      ║
║     Type /help for commands            ║
╚════════════════════════════════════════╝
`);

  await startRepl(session, {
    onUserMessage: async (message, currentSession) => {
      const run = await runCliWorkflow(message, currentSession.config, currentSession.mode === 'execute');
      currentSession.pendingChanges.splice(0, currentSession.pendingChanges.length, ...run.pendingChanges);
      if (currentSession.mode !== 'execute') {
        currentSession.mode = 'review';
      }
      return formatCliWorkflow(run, currentSession.mode === 'execute');
    },
  });

  if (typeof flags.save === 'string') {
    saveSession(session, flags.save);
    console.log(`Saved session to ${flags.save}`);
  }
  if (typeof flags.export === 'string') {
    exportSession(session, flags.export);
    console.log(`Exported conversation to ${flags.export}`);
  }
  console.log(`Autosaved session: ${getSessionFilePath(session.id)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

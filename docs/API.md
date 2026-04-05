# JackCode API Reference

This document summarizes the public and practically reusable APIs present in the current JackCode repository.

## Modules

Main areas in the codebase:

- `src/cli/*` — CLI parsing, rendering, REPL, session persistence
- `src/core/*` — runtime, session management, recovery, execution UX
- `src/repo/*` — repository scanning, symbol indexing, impact analysis, context compression
- `src/tools/*` — patching and test execution
- `src/model/*` — model routing and policy logic
- `src/types/*` — shared type definitions

---

## CLI Module

Source: `src/cli/index.ts`

### `parseArgs(args: string[]): ParseResult`

Parses command-line arguments into a normalized structure.

#### Recognized modes

- `chat`
- `oneshot`
- `execute`
- `help`
- `version`

#### Recognized options

- `--help`, `-h`
- `--version`, `-v`
- `--model`, `-m`
- `--no-stream`
- `--theme`
- `--history-file`
- `--resume`
- `--load`
- `--save`
- `--export`
- `--execute`, `-e`

#### Returns

```ts
interface ParseResult {
  mode: CLIMode;
  config: CLIConfig;
  prompt?: string;
  flags: Record<string, string | boolean>;
}
```

### `main(args?: string[]): Promise<void>`

Top-level CLI dispatcher.

Dispatches to:

- help output
- version output
- one-shot mode
- execute mode
- interactive mode

### Re-exported helpers

The CLI entry module re-exports these from `src/cli/chat.ts`:

- `createChatSession`
- `createRenderer`
- `exportSession`
- `formatMessage`
- `getSessionFilePath`
- `loadSession`
- `resumeLatestSession`
- `saveSession`
- `startRepl`

---

## CLI Chat / REPL Module

Source: `src/cli/chat.ts`

### Session construction

#### `createChatSession(config: CLIConfig, options?: CreateChatSessionOptions): ChatSession`

Creates an in-memory chat session.

```ts
interface CreateChatSessionOptions {
  id?: string;
  messages?: ChatMessage[];
  contextWindow?: number;
  mode?: SessionMode;
  pendingChanges?: PendingChange[];
  startTime?: number;
}
```

#### `generateSessionId(): string`

Creates an id like `jc-xxxxxxxx`.

#### `createInitialChatState(): ChatState`

Creates default REPL state:

```ts
{
  isProcessing: false,
  currentStream: null,
  lastActivity: Date.now()
}
```

### Input parsing

#### `parseInput(rawInput: string): ParsedInput`

Recognizes:

- `/...` as slash commands
- `@...` as file input references
- `/exit` and `/quit` as exit
- everything else as chat

```ts
interface ParsedInput {
  type: 'chat' | 'slash' | 'file' | 'exit';
  slashCommand?: string;
  args: string[];
  raw: string;
}
```

### Message helpers

#### `addMessage(session, role, content, metadata?): ChatMessage`

Appends a message to the session and returns it.

#### `formatMessage(message, options): string`

Formats a single message for terminal output.

#### `formatCodeBlocks(content, theme, compact?): string`

Pretty-prints fenced code blocks with ASCII framing.

### Rendering

#### `createRenderer(theme: Theme): ChatRenderer`

Returns a renderer with:

- `renderMessage(message)`
- `renderStatus(session, state)`
- `renderProgress(label, current?, total?)`
- `renderError(error)`
- `formatInputPreview(inputText)`

#### `resolveTheme(theme: Theme): 'dark' | 'light'`

Resolves `auto` based on environment.

#### `colorize(text, color, theme): string`

Applies ANSI styling unless `NO_COLOR` is set.

#### `renderProgress(label, current?, total?, theme?): string`

Renders progress text like `⏳ Thinking...`.

#### `renderError(error, theme?): string`

Formats an error line.

#### `renderStatusLine(session, state, theme?): string`

Shows session id, mode, model, message count, pending changes, and busy/idle state.

### Persistence

#### `getSessionDirectory(cwd?): string`

Returns the `.jackcode` directory for a working directory.

#### `getSessionFilePath(sessionId, cwd?): string`

Returns `.jackcode/session-<id>.json`.

#### `ensureParentDir(filePath): void`

Creates parent directories recursively.

#### `saveSession(session, filePath?): string`

Writes a persisted session payload to disk.

#### `loadSession(filePath): ChatSession`

Loads a session from disk.

Accepts either:

- the wrapped persisted format with `{ version, savedAt, session }`
- or a raw `ChatSession`

#### `exportSession(session, filePath): string`

Writes a Markdown transcript.

#### `resumeLatestSession(cwd?): ChatSession | null`

Loads the newest saved `session-*.json` file from `.jackcode/`.

### Slash commands

#### `createSlashCommands(customCommands?: SlashCommand[]): Map<string, SlashCommand>`

Builds the built-in command registry and merges custom commands.

Built-ins include:

- `help`
- `status`
- `clear`
- `save`
- `load`
- `export`
- `model`
- `theme`
- `session`
- `resume`
- `history`
- `plan`
- `execute`
- `review`
- `diff`
- `context`
- `undo`

#### `buildHelpText(commands): string`

Renders command help from the registry.

#### `executeSlashCommand(commandName, args, context): Promise<boolean>`

Runs a slash command and returns whether it was found.

### REPL

#### `createCompleter(commands): readline.Completer`

Creates slash-command completion for readline.

#### `startRepl(session, options?): Promise<void>`

Starts the interactive loop.

```ts
interface StartReplOptions {
  cwd?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  customCommands?: SlashCommand[];
  onUserMessage?: (message: string, session: ChatSession) => Promise<ChatMessage | string | void> | ChatMessage | string | void;
  onSlashCommand?: (command: string, args: string[], session: ChatSession) => Promise<void> | void;
}
```

Behavior notes:

- loads readline history from `config.historyFile`
- autosaves session after each successful interaction
- supports multiline input with trailing `\`
- supports fenced-code multiline mode
- uses double Ctrl+C to exit when idle
- aborts the current request on Ctrl+C when processing

#### `resolveInputFilePath(inputPath, cwd?): string`

Resolves user-provided paths against the working directory.

### Stream handler

#### `class DefaultStreamHandler implements StreamHandler`

Methods:

- `onChunk(chunk)`
- `onThinkingStart()`
- `onThinkingEnd()`
- `onComplete(result)`
- `onError(error)`

Properties:

- `content: string`
- `isThinking: boolean`

---

## CLI Types

Source: `src/types/cli.ts`

### Model and mode types

```ts
type ModelTier = 'qwen-3.6' | 'deepseek' | 'gpt54';
type CLIMode = 'chat' | 'oneshot' | 'execute' | 'help' | 'version';
type Theme = 'dark' | 'light' | 'auto';
type SessionMode = 'plan' | 'execute' | 'review' | 'idle';
```

### Config

```ts
interface CLIConfig {
  defaultModel: ModelTier;
  theme: Theme;
  streaming: boolean;
  showTokenCount: boolean;
  historyFile: string;
}
```

### Session and message types

```ts
interface ChatSession {
  id: string;
  config: CLIConfig;
  messages: ChatMessage[];
  contextWindow: number;
  mode: SessionMode;
  pendingChanges: PendingChange[];
  startTime: number;
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
}
```

---

## Session Manager API

Source: `src/core/session.ts`

### Exports

- `class SessionManager`
- `const sessionManager`

### Constructor

```ts
new SessionManager(options?: SessionManagerOptions)
```

```ts
interface SessionManagerOptions {
  persistence?: SessionPersistenceConfig;
  memoryAdapter?: JackClawMemoryAdapter;
}
```

### Event subscription

#### `on(event, handler): void`

Subscribes to session lifecycle events.

Notable events:

- `session-created`
- `session-updated`
- `session-closed`
- `state-change`
- `task-start`
- `task-push`
- `task-pop`
- `task-update`
- `task-complete`
- `task-fail`
- `checkpoint-created`
- `checkpoint-restored`
- `context-compressed`
- `memory-synced`
- `handoff-prepared`
- `runtime-attached`
- `runtime-updated`
- `patch-added`
- `test-result-added`
- `repo-snapshot-updated`
- `error`

### Session lifecycle methods

#### `createSession(options: SessionCreateOptions): Session`

Creates and activates a session.

#### `getSession(id): Session | undefined`
#### `listSessions(): Session[]`
#### `closeSession(id): boolean`
#### `pauseSession(id): boolean`
#### `resumeSession(id): boolean`
#### `setErrorState(id, error): boolean`

### Runtime integration

#### `attachToRuntime(sessionId, runtime): boolean`

Synchronizes runtime queue state into the session.

### Task management

#### `pushTask(sessionId, goal, options?): TaskContext | null`
#### `popTask(sessionId): TaskContext | null`
#### `completeTask(sessionId, taskId): boolean`
#### `failTask(sessionId, taskId, error?): boolean`
#### `updateTaskStatus(sessionId, taskId, status): boolean`
#### `getTaskStack(sessionId): TaskContext[]`
#### `getGoalHierarchy(sessionId): GoalNode[]`
#### `addTaskNote(sessionId, taskId, note): boolean`

### Context management

#### `addContextFragment(sessionId, fragment, taskId?): boolean`
#### `addContextFragments(sessionId, fragments, taskId?): number`
#### `getContextFragments(sessionId): ContextFragment[]`
#### `getContextWindow(sessionId): SessionContextWindow | null`
#### `shouldCompressContext(sessionId): boolean`
#### `compressContext(sessionId, targetBudget?): ContextCompressionResult | null`
#### `selectContext(sessionId, budget): SessionContextSelection | null`

### Checkpoints and recovery

#### `createCheckpoint(sessionId, files, options?): Promise<Checkpoint | null>`
#### `getCheckpoints(sessionId): Checkpoint[]`
#### `findCheckpoint(sessionId, tag): Checkpoint | undefined`
#### `restoreCheckpoint(sessionId, checkpointIdOrTag): boolean`
#### `recoverSession(sessionId): SessionRecoveryResult | null`

### Handoff and model tracking

#### `prepareHandoff(sessionId, fromModel, toModel, relevantFiles, expectedActions): HandoffPayload | null`
#### `recordModelUsage(sessionId, model, tokensIn, tokensOut, cost, options?): boolean`
#### `getModelUsage(sessionId): ModelUsage[]`
#### `getModelUsageTotals(sessionId): ModelUsageTotals`
#### `getTotalCost(sessionId): number`

### Persistence

#### `saveSession(sessionId): string | null`

Writes serialized session data under the configured persistence directory.

### Memory sync

#### `pushMemory(sessionId, options?): Promise<MemorySyncDetails | null>`
#### `pullMemory(sessionId, options?): Promise<MemorySyncDetails | null>`

### Patch / test / repo snapshot integration

#### `addPatch(sessionId, file, patch): SessionPatchRecord | null`
#### `addTestResult(sessionId, result): SessionTestResultRecord | null`
#### `setRepoSnapshot(sessionId, snapshot): boolean`

---

## Session Types

Source: `src/types/session.ts`

Important types:

- `SessionState = 'created' | 'active' | 'paused' | 'error' | 'closed'`
- `TaskStatus = 'pending' | 'in-progress' | 'completed' | 'blocked' | 'failed'`
- `Session`
- `TaskContext`
- `GoalNode`
- `Checkpoint`
- `SessionSnapshot`
- `HandoffPayload`
- `ModelUsage`
- `SessionContextWindow`
- `SessionCreateOptions`
- `CheckpointCreateOptions`
- `TaskCreateOptions`
- `ContextCompressionResult`
- `SessionEvents`

The `Session` object also receives convenience instance methods when created through `SessionManager`:

- `attachToRuntime(runtime)`
- `addPatch(file, patch)`
- `addTestResult(result)`
- `setRepoSnapshot(snapshot)`
- `selectContext(budget)`

---

## Runtime Example API

Reference source: `src/core/runtime.example.ts`

The example demonstrates use of:

- `RuntimeStateMachine`
- `sessionManager`
- `qwenRouter`
- `recoveryEngine`

Observed runtime operations in the example:

- `new RuntimeStateMachine(deps, options)`
- `runtime.on('state-changed', handler)`
- `runtime.createTask(intent, options)`
- `runtime.setPlan(taskId, plan)`
- `runtime.runTask(taskId)`

Persistence option shown in the example:

```ts
{
  persistencePath: '.jackcode/runtime-example.json',
  autoPersist: true
}
```

---

## Repository Analysis API

Source: `src/repo/index.ts`

### Exports

- `ImpactAnalyzer`
- `createImpactAnalyzer`
- `SymbolIndex`
- `buildSymbolIndex`

### `class ImpactAnalyzer`

Source: `src/repo/impact-analyzer.ts`

#### Constructor

```ts
new ImpactAnalyzer(options?: Partial<ImpactAnalyzerOptions>)
```

#### Main methods

- `analyze(changes): Promise<ImpactReport>`
- `invalidateCache(paths?): void`
- `rebuildGraph(): Promise<void>`
- `getNode(path): DependencyNode | undefined`
- `hasDependency(from, to): boolean`
- `updateNode(node): void`
- `getAllNodes(): Map<string, DependencyNode>`
- `useSymbolIndex(symbolIndex): this`
- `useRepoScanner(scanner): this`

#### Typical usage

Use it to:

- analyze direct and transitive impact of file or symbol changes
- discover affected tests
- build risk assessments and recommendations
- trace dependency and symbol ripples

---

## Patch Engine API

Source: `src/tools/patch.ts`

### Planning and application

#### `planPatches(changes, config?): PatchPlan`

Creates a patch plan from one or more `ChangeRequest`s.

#### `applyPatch(plan, sessionId?): Promise<PatchResult>`

Applies a patch plan in sorted file order.

Behavior includes:

- lock file creation
- checksum verification
- hunk application with fuzzy matching
- syntax/build verification for some file types
- reverse snapshot storage for rollback
- best-effort rollback on failure

#### `rollbackPatch(patchId): Promise<RollbackResult>`

Restores from stored reverse patch data.

### Diff and validation

#### `summarizeDiff(patches): DiffSummary`
#### `generateUnifiedDiff(patch): string`
#### `generateReversePatch(patch): Patch`
#### `validatePatch(patch): { valid: boolean; errors: string[] }`

### Patch creation helpers

#### `buildPatchFromRequest(request, config?): Promise<Patch>`

Builds a single patch by reading the current file state first.

### Verification / history helpers

#### `getPatchHistory(): readonly PatchHistoryEntry[]`
#### `canRollback(patchId): boolean`
#### `getActiveSnapshotIds(): string[]`
#### `cleanupSnapshots(maxAgeDays?): Promise<string[]>`

### Important patch types

Source: `src/types/patch.ts`

- `ChangeRequest`
- `LineRange`
- `PatchPlan`
- `Patch`
- `Hunk`
- `ReversePatch`
- `PatchResult`
- `FailedPatch`
- `RollbackResult`
- `DiffSummary`
- `FileSummary`
- `DiffStats`
- `PatchEngineConfig`
- `PatchHistoryEntry`
- `PatchApplyOptions`

Example `ChangeRequest`:

```ts
{
  targetPath: 'src/example.ts',
  description: 'Add helper function',
  insertion: 'export function helper() {}\n'
}
```

---

## Model Router API

Reference sources:

- `src/model/router.ts`
- `src/model/qwen-router.ts`
- `src/model/types.ts`

### Qwen router

#### `class QwenExecutorRouter`

Constructor:

```ts
new QwenExecutorRouter(config?: Partial<RouterConfig>)
```

Main methods:

- `route(request): Promise<QwenRouteResult>`
- `batchRoute(requests): Promise<QwenRouteResult[]>`
- `canHandle(contextSize): boolean`
- `getMetrics(): RouterMetrics`

Exports:

- `qwenRouter`
- `createQwenRouter(config?)`

### Important router types

```ts
type RoutePriority = 'normal' | 'high' | 'critical';
type OperationType = 'edit' | 'create' | 'delete' | 'refactor';
```

```ts
interface QwenRouteRequest {
  taskId: string;
  context: CompressedContext;
  operations: CodeOperation[];
  priority: RoutePriority;
  timeoutMs: number;
}
```

```ts
interface QwenRouteResult {
  taskId: string;
  success: boolean;
  operations: CompletedOperation[];
  metrics: ExecutionMetrics;
  escalation?: EscalationReason;
}
```

---

## Workflow Executor API

Source: `src/core/executor.ts`

### Exports

- `WorkflowPresenter`
- `SummaryGenerator`
- `ApprovalController`
- `WorkflowExecutor`
- `workflowExecutor`

### `class WorkflowPresenter`

Renders workflow state in `compact`, `detailed`, or `json` formats.

#### Constructor

```ts
new WorkflowPresenter(config?: Partial<WorkflowPresenterConfig>)
```

#### Methods

- `render(state): string`

### `class SummaryGenerator`

Static methods:

- `create(patchResult, verification?, options?): TaskSummary`
- `format(summary, level?): string`

### `class ApprovalController`

Evaluates change sets against approval rules.

#### Constructor

```ts
new ApprovalController(rules?: ApprovalRule[])
```

#### Methods

- `addRule(rule): void`
- `evaluate(operation, userOverrides?): ApprovalDecision`

### `class WorkflowExecutor`

High-level integration of presenter + approval controller.

#### Constructor

```ts
new WorkflowExecutor(presenterConfig?, approvalRules?)
```

#### Methods

- `execute(task, operation, options): Promise<{ approved: boolean; result?: PatchResult; summary?: TaskSummary }>`
- `renderState(state): string`

---

## Repo Scanner API

Source: `src/core/scanner.ts`

This file is large, but its purpose is clear from the exports and types: repository scanning, language detection, dependency discovery, git metadata, ignore handling, and incremental scans.

Relevant types are defined in `src/types/scanner.ts`, including:

- `ScannerConfig`
- `ScanOptions`
- `FileIndex`
- `FileEntry`
- `DirectoryEntry`
- `LanguageStats`
- `GitInfo`
- `RepoStats`
- `ScanResult`
- `ScanError`

Use this layer when you need a structured index of the repository to power impact analysis, symbol graphs, or context compression.

---

## Type Barrel

Source: `src/types/index.ts`

JackCode exposes a barrel file that re-exports:

- `cli`
- `context`
- `impact-analyzer`
- `integration-qa`
- `memory-adapter`
- `patch`
- `repairer`
- `reviewer`
- `scanner`
- `session`
- `symbol-index`
- `telemetry`
- `test-runner`

If you want broad type access from one import surface, this is the place to start.

---

## Minimal integration examples

### Create and persist a CLI session

```ts
import {
  createChatSession,
  saveSession,
} from '../src/cli/index.js';

const session = createChatSession({
  defaultModel: 'qwen-3.6',
  theme: 'auto',
  streaming: true,
  showTokenCount: true,
  historyFile: '.jackcode/history',
});

saveSession(session);
```

### Analyze change impact

```ts
import { createImpactAnalyzer } from '../src/repo/index.js';

const analyzer = createImpactAnalyzer({
  rootDir: process.cwd(),
});

const report = await analyzer.analyze({
  path: 'src/core/session.ts',
  type: 'modify',
  scope: 'file',
});

console.log(report.summary);
```

### Plan and apply patches

```ts
import { planPatches, applyPatch } from '../src/tools/patch.js';

const plan = planPatches([
  {
    targetPath: 'src/example.ts',
    description: 'Add export',
    insertion: 'export const value = 1;\n',
  },
]);

const result = await applyPatch(plan);
console.log(result.success);
```

### Manage a long-lived session

```ts
import { SessionManager } from '../src/core/session.js';

const manager = new SessionManager({
  persistence: {
    baseDir: '.jackcode/sessions',
    autoSave: true,
  },
});

const session = manager.createSession({
  rootGoal: 'Ship a safe runtime refactor',
});

manager.pushTask(session.id, 'Update transitions');
manager.addTaskNote(session.id, session.currentTask!.id, 'Decision: explicit states | easier to debug');
```

---

## Stability notes

This repository is still in an early stage, so the most stable surfaces right now are:

- CLI session helpers
- session persistence and REPL
- patch planning/apply/rollback primitives
- impact analysis primitives
- type definitions

The exact runtime/model orchestration surfaces may continue evolving as the implementation fills in.

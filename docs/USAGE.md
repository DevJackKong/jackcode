# JackCode Usage Guide

This guide covers how to install, run, configure, and embed JackCode.

> Current status: JackCode is a TypeScript project with a working CLI entrypoint in `src/cli/index.ts` and compiled output in `dist/cli/index.js`. The repository does **not** currently expose a published global `jackcode` binary through `package.json`, so the commands below use `node dist/cli/index.js` after build, or `node --import tsx src/cli/index.ts` in development.

## Getting Started

### Requirements

- Node.js 22+
- npm

### Install dependencies

From the project root:

```bash
npm install
```

### Build the project

```bash
npm run build
```

This compiles TypeScript into `dist/`.

### First run

Interactive mode:

```bash
node dist/cli/index.js chat
```

One-shot mode:

```bash
node dist/cli/index.js "refactor auth.ts"
```

Execute mode:

```bash
node dist/cli/index.js --execute "implement retry logic for API client"
```

### Development mode

If you want to run directly from source without building first:

```bash
node --import tsx src/cli/index.ts chat
```

## CLI Commands

JackCode supports three main usage styles:

- **chat**: interactive REPL session
- **run**: one-shot prompt execution
- **resume**: continue the latest saved interactive session

Because the current CLI is implemented as flags and modes rather than separate subcommands, "run" maps to the default one-shot invocation and "resume" maps to `--resume`.

### Global options

```text
-h, --help
-v, --version
-m, --model <tier>
-e, --execute
--no-stream
--theme <theme>
--history-file <path>
--resume
--load <path>
--save <path>
--export <path>
```

### chat

Start an interactive session:

```bash
node dist/cli/index.js chat
```

Or simply:

```bash
node dist/cli/index.js
```

Useful options:

```bash
node dist/cli/index.js chat --theme dark --model deepseek
node dist/cli/index.js --resume
node dist/cli/index.js --load .jackcode/session-jc-1234.json
```

What chat mode does:

- opens a readline-based REPL
- autosaves the session after each interaction
- persists command history to the configured history file
- supports slash commands like `/help`, `/model`, `/save`, `/load`, `/review`
- supports multiline input:
  - end a line with `\` to continue
  - or use fenced code blocks with triple backticks

#### Interactive slash commands

Built-in slash commands:

- `/help` — show commands
- `/status` — show current session state
- `/clear` — clear terminal screen
- `/save [file]` — save current session
- `/load <file>` — load session from disk
- `/export <file>` — export conversation as Markdown
- `/history [count]` — show recent messages
- `/plan [task]` — switch session mode to `plan`
- `/execute [task]` — switch session mode to `execute`
- `/review` — switch session mode to `review`
- `/diff` — show pending changes
- `/context` — show context window info
- `/undo` — drop the latest pending change
- `/model <qwen-3.6|deepseek|gpt54>` — switch model tier
- `/theme <dark|light|auto>` — switch terminal theme
- `/session` — show session and history file metadata
- `/resume` — load the most recent saved session
- `/exit` or `/quit` — exit

### run

One-shot mode is the default when you provide a prompt without `chat` or `--execute`:

```bash
node dist/cli/index.js "summarize the runtime state machine"
```

Equivalent examples:

```bash
node dist/cli/index.js -m qwen-3.6 "add tests for session persistence"
node dist/cli/index.js --theme light --save out/session.json "review this module"
node dist/cli/index.js --export out/conversation.md "explain the patch engine"
```

What one-shot mode does:

- creates a temporary chat session
- adds your prompt as a user message
- generates a single assistant reply
- optionally saves or exports the conversation
- exits immediately after completion

### resume

Resume the most recent saved session:

```bash
node dist/cli/index.js --resume
```

Inside chat mode, you can also use:

```text
/resume
```

How resume works:

- JackCode looks in `.jackcode/`
- finds files named `session-*.json`
- sorts by modification time
- loads the newest one

### execute

Execute mode is intended for immediate-application workflows:

```bash
node dist/cli/index.js --execute "apply the planned refactor"
```

Current behavior in this repository:

- creates a session in `execute` mode
- records the prompt and a staged assistant response
- prints the result and exits
- optionally saves or exports the session

## Configuration

The CLI has a `CLIConfig` structure with these fields:

```ts
interface CLIConfig {
  defaultModel: 'qwen-3.6' | 'deepseek' | 'gpt54';
  theme: 'dark' | 'light' | 'auto';
  streaming: boolean;
  showTokenCount: boolean;
  historyFile: string;
}
```

### Default values

These defaults are currently hard-coded in `src/cli/index.ts`:

```json
{
  "defaultModel": "qwen-3.6",
  "theme": "auto",
  "streaming": true,
  "showTokenCount": true,
  "historyFile": ".jackcode/history"
}
```

### `.jackcode.json` format

The repository defines the config shape, but does **not** currently auto-load a `.jackcode.json` file in the CLI entrypoint. If you want a project-local config file, this is the sensible format to use in your own wrapper or future integration:

```json
{
  "defaultModel": "qwen-3.6",
  "theme": "auto",
  "streaming": true,
  "showTokenCount": true,
  "historyFile": ".jackcode/history"
}
```

Recommended field meanings:

- `defaultModel`: model tier used for replies and metadata
- `theme`: terminal color mode
- `streaming`: whether responses should stream progressively
- `showTokenCount`: whether UI should expose token metrics
- `historyFile`: readline history path

### Overriding config from the CLI

Flags override defaults at runtime:

```bash
node dist/cli/index.js --model deepseek --theme dark
node dist/cli/index.js --history-file .jackcode/my-history
node dist/cli/index.js --no-stream
```

## Sessions and persistence

JackCode persists interactive state under `.jackcode/`.

### Session files

Autosaved session path pattern:

```text
.jackcode/session-<session-id>.json
```

A saved payload looks like:

```json
{
  "version": 1,
  "savedAt": 1775360000000,
  "session": {
    "id": "jc-abc12345",
    "config": {
      "defaultModel": "qwen-3.6",
      "theme": "auto",
      "streaming": true,
      "showTokenCount": true,
      "historyFile": ".jackcode/history"
    },
    "messages": [],
    "contextWindow": 32,
    "mode": "idle",
    "pendingChanges": [],
    "startTime": 1775360000000
  }
}
```

### History file

Default readline history file:

```text
.jackcode/history
```

You can override it with:

```bash
node dist/cli/index.js --history-file .jackcode/custom-history
```

### Export format

`--export` and `/export` write a Markdown transcript with:

- session id
- start time
- mode
- model
- all messages in order

## Programming API

JackCode also exposes reusable functions and classes you can import from source modules.

### CLI API

From `src/cli/index.ts`:

- `parseArgs(args)`
- `main(args?)`
- `createChatSession(config, options?)`
- `createRenderer(theme)`
- `exportSession(session, filePath)`
- `formatMessage(message, options)`
- `getSessionFilePath(sessionId, cwd?)`
- `loadSession(filePath)`
- `resumeLatestSession(cwd?)`
- `saveSession(session, filePath?)`
- `startRepl(session, options?)`

Example:

```ts
import {
  createChatSession,
  saveSession,
  startRepl,
} from '../src/cli/index.js';

const session = createChatSession({
  defaultModel: 'qwen-3.6',
  theme: 'auto',
  streaming: true,
  showTokenCount: true,
  historyFile: '.jackcode/history',
});

await startRepl(session);
saveSession(session);
```

### Session API

From `src/core/session.ts`, the main export is `SessionManager` plus the singleton `sessionManager`.

Core capabilities include:

- create, pause, resume, recover, and close sessions
- manage nested tasks and goal trees
- record model usage and cost
- attach runtime queue state
- add context fragments and compress context
- create and restore checkpoints
- push and pull memory through an adapter
- store patch and test result history

Example:

```ts
import { SessionManager } from '../src/core/session.js';

const sessions = new SessionManager({
  persistence: {
    baseDir: '.jackcode/sessions',
    autoSave: true,
  },
});

const session = sessions.createSession({
  rootGoal: 'Implement task execution runtime',
});

sessions.pushTask(session.id, 'Add state transitions');
sessions.addTaskNote(session.id, session.currentTask!.id, 'Decision: use explicit state machine | easier to recover');
sessions.recordModelUsage(session.id, 'qwen-3.6', 1200, 300, 0.02, {
  latencyMs: 800,
  success: true,
});
```

### Runtime API

The runtime example in `src/core/runtime.example.ts` shows how to combine:

- `RuntimeStateMachine`
- `sessionManager`
- `qwenRouter`
- `recoveryEngine`

Typical flow:

1. create a session
2. construct the runtime with session, router, repairer, and executor hooks
3. create a runtime task
4. attach a plan
5. run the task

### Repository analysis API

From `src/repo/index.ts`:

```ts
export { ImpactAnalyzer, createImpactAnalyzer } from './impact-analyzer.js';
export { SymbolIndex, buildSymbolIndex } from './symbol-index.js';
```

Use this layer to:

- analyze change impact
- discover affected files and tests
- build symbol/import indexes

### Patch engine API

From `src/tools/patch.ts`, notable exports include:

- `planPatches(changes, config?)`
- `applyPatch(plan, sessionId?)`
- `rollbackPatch(patchId)`
- `summarizeDiff(patches)`
- `generateUnifiedDiff(patch)`
- `generateReversePatch(patch)`
- `validatePatch(patch)`
- `buildPatchFromRequest(request, config?)`
- `getPatchHistory()`
- `canRollback(patchId)`
- `cleanupSnapshots(maxAgeDays?)`

## Examples

### Example 1: start interactive chat

```bash
npm run build
node dist/cli/index.js chat
```

### Example 2: one-shot request with a specific model

```bash
node dist/cli/index.js --model deepseek "analyze impact of renaming SessionManager"
```

### Example 3: save and export a one-shot session

```bash
node dist/cli/index.js --save out/session.json --export out/session.md "explain the qwen router"
```

### Example 4: resume the last interactive session

```bash
node dist/cli/index.js --resume
```

### Example 5: run the CLI from source during development

```bash
node --import tsx src/cli/index.ts chat --theme dark
```

### Example 6: embed the REPL with a custom message handler

```ts
import {
  createChatSession,
  startRepl,
} from '../src/cli/index.js';

const session = createChatSession({
  defaultModel: 'qwen-3.6',
  theme: 'auto',
  streaming: true,
  showTokenCount: true,
  historyFile: '.jackcode/history',
});

await startRepl(session, {
  async onUserMessage(message, session) {
    return `Received in session ${session.id}: ${message}`;
  },
});
```

### Example 7: create and save a session programmatically

```ts
import {
  createChatSession,
  saveSession,
} from '../src/cli/index.js';

const session = createChatSession({
  defaultModel: 'gpt54',
  theme: 'light',
  streaming: false,
  showTokenCount: true,
  historyFile: '.jackcode/history',
});

session.messages.push({
  role: 'user',
  content: 'Draft a migration plan',
  timestamp: Date.now(),
});

saveSession(session, '.jackcode/manual-session.json');
```

### Example 8: build and apply a patch plan

```ts
import {
  planPatches,
  applyPatch,
  summarizeDiff,
} from '../src/tools/patch.js';

const plan = planPatches([
  {
    targetPath: 'src/example.ts',
    description: 'Add exported helper',
    insertion: 'export function hello() { return "hi"; }\n',
  },
]);

console.log(plan.impact);
console.log(summarizeDiff(plan.patches));

const result = await applyPatch(plan);
console.log(result.success);
```

## Notes and current limitations

A few things are worth knowing when using the current codebase:

- The help text prints `jackcode ...`, but `package.json` does not yet define a `bin` field.
- `.jackcode.json` is not auto-read by the CLI yet; the config shape exists, but loading it would need to be added.
- Current one-shot and execute flows are scaffolding-oriented and return staged responses rather than a full model-backed coding loop.
- Session persistence and REPL behavior are more complete than model execution plumbing at this stage.

If you want the exact callable API surface, see [API.md](./API.md).

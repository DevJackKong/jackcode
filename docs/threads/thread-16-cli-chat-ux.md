# Thread 16: CLI Chat UX

## Purpose
Provides the command-line interface and interactive chat experience for JackCode. Handles user input parsing, conversation flow, streaming output, and command dispatching.

## Responsibilities
- Parse CLI arguments and subcommands
- Manage interactive chat session lifecycle
- Handle streaming LLM responses with real-time output
- Support slash commands (`/plan`, `/execute`, `/review`, `/undo`, etc.)
- Provide rich terminal UI with syntax highlighting and progress indicators
- Manage conversation history and context window
- Route user intents to appropriate runtime handlers

## Design Decisions

### CLI Modes

```
┌─────────────────┐     ┌──────────────────┐
│   One-shot Mode │     │ Interactive Mode │
│   jackcode "..."│     │   jackcode chat  │
└────────┬────────┘     └────────┬─────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│ Execute & Exit  │     │  REPL Loop       │
│                 │     │  > user input    │
│                 │     │  AI response     │
└─────────────────┘     └──────────────────┘
```

### Chat Interface Structure

```
┌─────────────────────────────────────────────────────────┐
│  JackCode v0.1.0  │  Session: abc123  │  Model: qwen-3.6│
├─────────────────────────────────────────────────────────┤
│                                                         │
│  > Add error handling to the fetchUser function         │
│                                                         │
│  Planning...                                            │
│  ✓ Analyzed user.ts                                     │
│  ✓ Identified 2 error cases                             │
│                                                         │
│  ── Executing ────────────────────────────────────────  │
│  user.ts  │  +12 -3  │  Added try/catch wrapper        │
│                                                         │
│  [Review changes?] [y/n/d(diff)]                       │
│                                                         │
├─────────────────────────────────────────────────────────┤
│  /plan  /execute  /review  /undo  /help  /exit          │
└─────────────────────────────────────────────────────────┘
```

### Slash Commands

| Command | Description | Example |
|---------|-------------|---------|
| `/plan` | Generate execution plan without running | `/plan refactor auth.ts` |
| `/execute` | Run current plan or new task | `/execute` or `/execute add tests` |
| `/review` | Review last changes | `/review` |
| `/undo` | Revert last change | `/undo` |
| `/diff` | Show diff of pending changes | `/diff` |
| `/context` | Show current context window | `/context` |
| `/model` | Switch model tier | `/model deepseek` |
| `/session` | Show session info | `/session` |
| `/help` | Show available commands | `/help` |
| `/exit` | Quit interactive mode | `/exit` or `/quit` |

## Data Model

```typescript
interface ChatSession {
  id: string;
  messages: ChatMessage[];
  contextWindow: number;
  mode: 'plan' | 'execute' | 'review';
  pendingChanges: PendingChange[];
}

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
}

interface MessageMetadata {
  model?: string;
  tokensUsed?: number;
  latencyMs?: number;
  toolCalls?: ToolCall[];
}

interface CLIConfig {
  defaultModel: ModelTier;
  theme: 'dark' | 'light' | 'auto';
  streaming: boolean;
  showTokenCount: boolean;
  historyFile: string;
}
```

## Streaming Architecture

```typescript
interface StreamHandler {
  // Called when a new chunk arrives
  onChunk(chunk: string): void;
  
  // Called when reasoning/thinking starts
  onThinkingStart(): void;
  
  // Called when reasoning/thinking ends
  onThinkingEnd(): void;
  
  // Called on stream completion
  onComplete(result: StreamResult): void;
  
  // Called on stream error
  onError(error: Error): void;
}
```

## Command Parser

```typescript
interface ParsedCommand {
  type: 'chat' | 'slash' | 'file' | 'exit';
  slashCommand?: string;
  args: string[];
  raw: string;
}

// Parse user input into structured command
function parseInput(input: string): ParsedCommand;
```

## Integration Points

### With Thread 01 (Runtime State Machine)
- Chat commands trigger state transitions
- State changes are reflected in chat UI
- Runtime status shown in chat header

### With Thread 02 (Session Context)
- Chat messages populate session context
- Session context provides conversation memory
- Context window managed via `/context` command

### With Thread 09/10/11 (Model Routers)
- User input routed to appropriate model tier
- Model selection via `/model` command
- Streaming responses handled per model

## Files

- `src/cli/index.ts` - Main CLI entry and command dispatcher
- `src/cli/chat.ts` - Interactive REPL implementation
- `src/cli/streaming.ts` - Stream handling and output formatting
- `src/cli/commands.ts` - Slash command implementations
- `src/cli/renderer.ts` - Terminal UI rendering
- `src/types/cli.ts` - CLI type definitions

## Future Work

- File picker integration for `@file` references
- Image input support for UI/code screenshots
- Persistent conversation history
- Multi-line input mode
- Vim/emacs keybindings
- Plugin system for custom slash commands

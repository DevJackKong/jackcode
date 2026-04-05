/**
 * JackCode CLI Entry Point
 *
 * Handles command-line interface, argument parsing, and mode dispatching.
 * Supports both one-shot execution and interactive chat modes.
 */

import {
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
import type { CLIConfig, ModelTier, ParseResult, Theme } from '../types/cli.js';

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

/**
 * Run one-shot mode: execute task and exit
 */
async function runOneshot(
  prompt: string,
  config: CLIConfig,
  flags: Record<string, string | boolean>
): Promise<void> {
  const session = createChatSession(config);
  const renderer = createRenderer(config.theme);

  console.log(`JackCode | Model: ${config.defaultModel}`);
  console.log('─'.repeat(50));
  console.log(renderer.renderStatus(session, { isProcessing: false, currentStream: null, lastActivity: Date.now() }));
  console.log(formatMessage({ role: 'user', content: prompt, timestamp: Date.now() }, { theme: config.theme, showTimestamps: true, compact: false }));

  const reply = `One-shot mode received: ${prompt}`;
  session.messages.push({ role: 'user', content: prompt, timestamp: Date.now() });
  session.messages.push({
    role: 'assistant',
    content: reply,
    timestamp: Date.now(),
    metadata: { model: config.defaultModel, tokensUsed: reply.length, latencyMs: 0, toolCalls: [] },
  });
  console.log(formatMessage(session.messages[1]!, { theme: config.theme, showTimestamps: true, compact: false }));

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
  session.messages.push({ role: 'user', content: prompt, timestamp: Date.now() });
  session.messages.push({
    role: 'assistant',
    content: `Execute mode staged task: ${prompt}`,
    timestamp: Date.now(),
    metadata: { model: config.defaultModel, tokensUsed: prompt.length, latencyMs: 0, toolCalls: [] },
  });

  console.log(`JackCode Execute | Model: ${config.defaultModel}`);
  console.log('─'.repeat(50));
  for (const message of session.messages) {
    console.log(formatMessage(message, { theme: config.theme, showTimestamps: true, compact: false }));
  }

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

  await startRepl(session);

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

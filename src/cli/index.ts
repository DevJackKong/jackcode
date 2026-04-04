/**
 * JackCode CLI Entry Point
 * 
 * Handles command-line interface, argument parsing, and mode dispatching.
 * Supports both one-shot execution and interactive chat modes.
 */

import { createChatSession, startRepl } from './chat.js';
import { CLIConfig, CLIMode, ParseResult } from '../types/cli.js';

export { createChatSession, startRepl };

const DEFAULT_CONFIG: CLIConfig = {
  defaultModel: 'qwen-3.6',
  theme: 'auto',
  streaming: true,
  showTokenCount: true,
  historyFile: '.jackcode_history',
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
      case '-m':
        result.config.defaultModel = args[++i] as any;
        break;
      case '--no-stream':
        result.config.streaming = false;
        break;
      case '--theme':
        result.config.theme = args[++i] as any;
        break;
      case '--execute':
      case '-e':
        result.mode = 'execute';
        break;
      default:
        if (!arg.startsWith('-')) {
          // Positional argument is the prompt
          result.prompt = args.slice(i).join(' ');
          result.mode = 'oneshot';
          i = args.length;
        } else {
          result.flags[arg] = args[++i] || true;
        }
    }
  }

  return result;
}

/**
 * Main CLI entry point
 */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs(args);

  switch (parsed.mode) {
    case 'help':
      printHelp();
      break;
    case 'version':
      printVersion();
      break;
    case 'oneshot':
      await runOneshot(parsed.prompt!, parsed.config);
      break;
    case 'execute':
      await runExecute(parsed.prompt, parsed.config);
      break;
    case 'chat':
    default:
      await runInteractive(parsed.config);
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
  -m, --model <tier>              Set default model tier (qwen/deepseek/gpt54)
  -e, --execute                   Execute mode: apply changes immediately
  --no-stream                     Disable streaming output
  --theme <theme>                 Set theme (dark/light/auto)

Examples:
  jackcode "refactor auth.ts"     One-shot request
  jackcode chat                   Interactive session
  jackcode -m deepseek "..."      Use DeepSeek for this request

Interactive Commands:
  /plan <task>                    Generate execution plan
  /execute [task]                 Execute current plan or new task
  /review                         Review pending changes
  /undo                           Revert last change
  /diff                           Show current diff
  /context                        Show context window info
  /model <tier>                   Switch model tier
  /help                           Show available commands
  /exit, /quit                    Exit interactive mode
`);
}

/**
 * Print version information
 */
function printVersion(): void {
  console.log('JackCode v0.1.0');
}

/**
 * Run one-shot mode: execute task and exit
 */
async function runOneshot(prompt: string, config: CLIConfig): Promise<void> {
  console.log(`JackCode | Model: ${config.defaultModel}`);
  console.log('─'.repeat(50));
  
  // TODO: Integrate with runtime state machine (Thread 01)
  // TODO: Route to appropriate model (Thread 09/10/11)
  console.log(`\nTask: ${prompt}`);
  console.log('\n(One-shot execution not yet implemented)');
}

/**
 * Run execute mode: apply changes without confirmation
 */
async function runExecute(prompt: string | undefined, config: CLIConfig): Promise<void> {
  if (!prompt) {
    console.error('Error: --execute requires a prompt');
    process.exit(1);
  }
  
  console.log(`JackCode Execute | Model: ${config.defaultModel}`);
  console.log('─'.repeat(50));
  
  // TODO: Direct execution without interactive confirmation
  console.log(`\nExecuting: ${prompt}`);
  console.log('\n(Direct execution mode not yet implemented)');
}

/**
 * Run interactive chat mode
 */
async function runInteractive(config: CLIConfig): Promise<void> {
  console.log(`
╔════════════════════════════════════════╗
║     JackCode v0.1.0 - Interactive      ║
║     Type /help for commands            ║
╚════════════════════════════════════════╝
`);

  const session = createChatSession(config);
  await startRepl(session);
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}

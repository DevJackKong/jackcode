/**
 * JackCode interactive chat UX implementation.
 *
 * Includes:
 * - REPL helpers and input parsing
 * - slash command registry
 * - terminal rendering helpers
 * - session persistence / export
 * - lightweight interactive loop for CLI usage
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import type { Interface as ReadlineInterface } from 'node:readline';
import { stdin as input, stdout as output } from 'node:process';
import type {
  ChatMessage,
  ChatSession,
  ChatState,
  CLIConfig,
  MessageMetadata,
  ModelTier,
  ParsedInput,
  PendingChange,
  RenderOptions,
  SessionMode,
  SlashCommand,
  StreamHandler,
  StreamResult,
  Theme,
} from '../types/cli.js';

const ANSI = {
  reset: '\u001b[0m',
  bold: '\u001b[1m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[34m',
  magenta: '\u001b[35m',
  cyan: '\u001b[36m',
  gray: '\u001b[90m',
  bgRed: '\u001b[41m',
  bgBlue: '\u001b[44m',
  bgGray: '\u001b[100m',
} as const;

const SESSION_DIR_NAME = '.jackcode';
const SESSION_FILE_PREFIX = 'session-';

export interface SlashCommandContext {
  session: ChatSession;
  state: ChatState;
  renderer: ChatRenderer;
  commands: Map<string, SlashCommand>;
  customCommands: Map<string, SlashCommand>;
  persistPath: string;
  clearScreen: () => void;
  exit: () => void;
}

export interface ChatRenderer {
  theme: Theme;
  renderMessage(message: ChatMessage): string;
  renderStatus(session: ChatSession, state: ChatState): string;
  renderProgress(label: string, current?: number, total?: number): string;
  renderError(error: Error | string): string;
  formatInputPreview(inputText: string): string;
}

export interface CreateChatSessionOptions {
  id?: string;
  messages?: ChatMessage[];
  contextWindow?: number;
  mode?: SessionMode;
  pendingChanges?: PendingChange[];
  startTime?: number;
}

export interface StartReplOptions {
  cwd?: string;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  customCommands?: SlashCommand[];
  onUserMessage?: (message: string, session: ChatSession) => Promise<ChatMessage | string | void> | ChatMessage | string | void;
  onSlashCommand?: (command: string, args: string[], session: ChatSession) => Promise<void> | void;
}

interface PersistedSession {
  version: 1;
  savedAt: number;
  session: ChatSession;
}

export class DefaultStreamHandler implements StreamHandler {
  private readonly chunks: string[] = [];
  private thinking = false;

  onChunk(chunk: string): void {
    this.chunks.push(chunk);
  }

  onThinkingStart(): void {
    this.thinking = true;
  }

  onThinkingEnd(): void {
    this.thinking = false;
  }

  onComplete(_result: StreamResult): void {
    this.thinking = false;
  }

  onError(_error: Error): void {
    this.thinking = false;
  }

  get content(): string {
    return this.chunks.join('');
  }

  get isThinking(): boolean {
    return this.thinking;
  }
}

export function createChatSession(config: CLIConfig, options: CreateChatSessionOptions = {}): ChatSession {
  return {
    id: options.id ?? generateSessionId(),
    config,
    messages: options.messages ? [...options.messages] : [],
    contextWindow: options.contextWindow ?? 32,
    mode: options.mode ?? 'idle',
    pendingChanges: options.pendingChanges ? [...options.pendingChanges] : [],
    startTime: options.startTime ?? Date.now(),
  };
}

export function generateSessionId(): string {
  return `jc-${Math.random().toString(36).slice(2, 10)}`;
}

export function createInitialChatState(): ChatState {
  return {
    isProcessing: false,
    currentStream: null,
    lastActivity: Date.now(),
  };
}

export function parseInput(rawInput: string): ParsedInput {
  const raw = rawInput.trim();

  if (raw === '/exit' || raw === '/quit') {
    return { type: 'exit', args: [], raw };
  }

  if (raw.startsWith('/')) {
    const parts = raw.slice(1).split(/\s+/).filter(Boolean);
    return {
      type: 'slash',
      slashCommand: parts[0] ?? '',
      args: parts.slice(1),
      raw,
    };
  }

  if (raw.startsWith('@')) {
    return {
      type: 'file',
      args: raw.slice(1).split(/\s+/).filter(Boolean),
      raw,
    };
  }

  return {
    type: 'chat',
    args: raw ? [raw] : [],
    raw,
  };
}

export function addMessage(
  session: ChatSession,
  role: ChatMessage['role'],
  content: string,
  metadata?: MessageMetadata
): ChatMessage {
  const message: ChatMessage = {
    role,
    content,
    timestamp: Date.now(),
    metadata,
  };
  session.messages.push(message);
  return message;
}

export function createRenderer(theme: Theme): ChatRenderer {
  return {
    theme,
    renderMessage(message) {
      return formatMessage(message, { theme, showTimestamps: true, compact: false });
    },
    renderStatus(session, state) {
      return renderStatusLine(session, state, theme);
    },
    renderProgress(label, current, total) {
      return renderProgress(label, current, total, theme);
    },
    renderError(error) {
      return renderError(error, theme);
    },
    formatInputPreview(inputText) {
      return highlightInput(inputText, theme);
    },
  };
}

export function resolveTheme(theme: Theme): Exclude<Theme, 'auto'> {
  if (theme === 'auto') {
    return process.env.NO_COLOR ? 'light' : 'dark';
  }
  return theme;
}

export function colorize(text: string, color: keyof typeof ANSI, theme: Theme): string {
  if (process.env.NO_COLOR) {
    return text;
  }

  const resolvedTheme = resolveTheme(theme);
  if (resolvedTheme === 'light' && color === 'gray') {
    return `${ANSI.dim}${text}${ANSI.reset}`;
  }

  return `${ANSI[color]}${text}${ANSI.reset}`;
}

export function formatMessage(message: ChatMessage, options: RenderOptions): string {
  const roleColor: Record<ChatMessage['role'], keyof typeof ANSI> = {
    user: 'cyan',
    assistant: 'green',
    system: 'magenta',
  };

  const stamp = options.showTimestamps
    ? `${colorize(`[${new Date(message.timestamp).toLocaleTimeString()}]`, 'gray', options.theme)} `
    : '';
  const label = colorize(message.role.toUpperCase(), roleColor[message.role], options.theme);
  const body = formatCodeBlocks(message.content, options.theme, options.compact);
  return `${stamp}${label}: ${body}`;
}

export function formatCodeBlocks(content: string, theme: Theme, compact = false): string {
  const segments = content.split(/```/g);
  if (segments.length === 1) {
    return compact ? content.trim() : content;
  }

  return segments
    .map((segment, index) => {
      if (index % 2 === 0) {
        return compact ? segment.trim() : segment;
      }

      const lines = segment.replace(/^\n+|\n+$/g, '').split('\n');
      const language = lines[0]?.match(/^[a-z0-9_+-]+$/i) ? lines.shift() ?? 'text' : 'text';
      const header = colorize(`┌─ code:${language}`, 'yellow', theme);
      const body = lines.map((line) => `${colorize('│', 'gray', theme)} ${line}`).join('\n');
      const footer = colorize('└─', 'yellow', theme);
      return [header, body, footer].filter(Boolean).join('\n');
    })
    .join(compact ? ' ' : '\n');
}

export function highlightInput(inputText: string, theme: Theme): string {
  if (inputText.startsWith('/')) {
    return colorize(inputText, 'blue', theme);
  }
  if (inputText.startsWith('@')) {
    return colorize(inputText, 'yellow', theme);
  }
  return inputText;
}

export function renderProgress(label: string, current = 0, total = 0, theme: Theme = 'auto'): string {
  const suffix = total > 0 ? ` ${current}/${total}` : '';
  const dots = '.'.repeat(Math.max(0, 3 - (label.length % 4)));
  return colorize(`⏳ ${label}${dots}${suffix}`, 'yellow', theme);
}

export function renderError(error: Error | string, theme: Theme = 'auto'): string {
  const message = error instanceof Error ? error.message : error;
  return colorize(`✖ ${message}`, 'red', theme);
}

export function renderStatusLine(session: ChatSession, state: ChatState, theme: Theme = 'auto'): string {
  const segments = [
    `Session ${session.id}`,
    `Mode ${session.mode}`,
    `Model ${session.config.defaultModel}`,
    `Messages ${session.messages.length}`,
    `Pending ${session.pendingChanges.length}`,
    state.isProcessing ? 'Busy' : 'Idle',
  ];
  return colorize(segments.join('  |  '), 'gray', theme);
}

export function getSessionDirectory(cwd = process.cwd()): string {
  return resolve(cwd, SESSION_DIR_NAME);
}

export function getSessionFilePath(sessionId: string, cwd = process.cwd()): string {
  return join(getSessionDirectory(cwd), `${SESSION_FILE_PREFIX}${sessionId}.json`);
}

export function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

export function saveSession(session: ChatSession, filePath?: string): string {
  const targetPath = filePath ?? getSessionFilePath(session.id);
  ensureParentDir(targetPath);

  const payload: PersistedSession = {
    version: 1,
    savedAt: Date.now(),
    session,
  };

  writeFileSync(targetPath, JSON.stringify(payload, null, 2), 'utf8');
  return targetPath;
}

export function loadSession(filePath: string): ChatSession {
  const raw = readFileSync(filePath, 'utf8');
  const payload = JSON.parse(raw) as PersistedSession | ChatSession;
  return 'session' in payload ? payload.session : payload;
}

export function exportSession(session: ChatSession, filePath: string): string {
  ensureParentDir(filePath);
  const lines = [
    `# JackCode Conversation Export`,
    '',
    `- Session: ${session.id}`,
    `- Started: ${new Date(session.startTime).toISOString()}`,
    `- Mode: ${session.mode}`,
    `- Model: ${session.config.defaultModel}`,
    '',
  ];

  for (const message of session.messages) {
    lines.push(`## ${message.role.toUpperCase()} — ${new Date(message.timestamp).toISOString()}`);
    lines.push('');
    lines.push(message.content);
    lines.push('');
  }

  writeFileSync(filePath, lines.join('\n'), 'utf8');
  return filePath;
}

export function resumeLatestSession(cwd = process.cwd()): ChatSession | null {
  const dir = getSessionDirectory(cwd);
  if (!existsSync(dir)) {
    return null;
  }

  const files = readdirSync(dir)
    .filter((name) => name.startsWith(SESSION_FILE_PREFIX) && name.endsWith('.json'))
    .map((name) => join(dir, name));

  if (files.length === 0) {
    return null;
  }

  files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  return loadSession(files[0]!);
}

export function createSlashCommands(customCommands: SlashCommand[] = []): Map<string, SlashCommand> {
  const commands = new Map<string, SlashCommand>();

  const register = (command: SlashCommand) => {
    commands.set(command.name, command);
  };

  register({
    name: 'help',
    description: 'Show available slash commands',
    usage: '/help',
    handler: async (_args, session) => {
      addMessage(session, 'system', buildHelpText(commands));
    },
  });

  register({
    name: 'status',
    description: 'Show current session status',
    usage: '/status',
    handler: async (_args, session) => {
      addMessage(session, 'system', `Session ${session.id}\nMode: ${session.mode}\nMessages: ${session.messages.length}\nPending changes: ${session.pendingChanges.length}\nModel: ${session.config.defaultModel}`);
    },
  });

  register({
    name: 'clear',
    description: 'Clear terminal screen',
    usage: '/clear',
    handler: async (_args, session) => {
      addMessage(session, 'system', 'Screen cleared.');
    },
  });

  register({
    name: 'save',
    description: 'Persist current session to disk',
    usage: '/save [file]',
    handler: async (args, session) => {
      const target = args[0] ? resolve(args[0]) : saveSession(session);
      if (args[0]) {
        saveSession(session, target);
      }
      addMessage(session, 'system', `Saved session to ${target}`);
    },
  });

  register({
    name: 'load',
    description: 'Load a session from disk',
    usage: '/load <file>',
    handler: async (args, session) => {
      const file = args[0];
      if (!file) {
        throw new Error('Usage: /load <file>');
      }
      const loaded = loadSession(resolve(file));
      session.messages.splice(0, session.messages.length, ...loaded.messages);
      session.pendingChanges.splice(0, session.pendingChanges.length, ...loaded.pendingChanges);
      session.contextWindow = loaded.contextWindow;
      session.mode = loaded.mode;
      session.startTime = loaded.startTime;
      session.config = { ...loaded.config };
      addMessage(session, 'system', `Loaded session ${loaded.id} from ${resolve(file)}`);
    },
  });

  register({
    name: 'export',
    description: 'Export conversation to a markdown file',
    usage: '/export <file>',
    handler: async (args, session) => {
      const file = args[0];
      if (!file) {
        throw new Error('Usage: /export <file>');
      }
      const target = resolve(file);
      exportSession(session, target);
      addMessage(session, 'system', `Exported conversation to ${target}`);
    },
  });

  register({
    name: 'model',
    description: 'Switch active model tier',
    usage: '/model <qwen-3.6|deepseek|gpt54>',
    handler: async (args, session) => {
      const model = args[0] as ModelTier | undefined;
      if (model !== 'qwen-3.6' && model !== 'deepseek' && model !== 'gpt54') {
        throw new Error('Usage: /model <qwen-3.6|deepseek|gpt54>');
      }
      session.config.defaultModel = model;
      addMessage(session, 'system', `Model switched to ${model}`);
    },
  });

  register({
    name: 'theme',
    description: 'Switch chat theme',
    usage: '/theme <dark|light|auto>',
    handler: async (args, session) => {
      const theme = args[0] as Theme | undefined;
      if (theme !== 'dark' && theme !== 'light' && theme !== 'auto') {
        throw new Error('Usage: /theme <dark|light|auto>');
      }
      session.config.theme = theme;
      addMessage(session, 'system', `Theme switched to ${theme}`);
    },
  });

  register({
    name: 'session',
    description: 'Show session file path and metadata',
    usage: '/session',
    handler: async (_args, session) => {
      addMessage(session, 'system', `Session file: ${getSessionFilePath(session.id)}\nHistory file: ${resolve(session.config.historyFile)}\nHost: ${os.hostname()}`);
    },
  });

  register({
    name: 'resume',
    description: 'Resume latest saved session',
    usage: '/resume',
    handler: async (_args, session) => {
      const latest = resumeLatestSession();
      if (!latest) {
        throw new Error('No saved session found to resume');
      }
      session.messages.splice(0, session.messages.length, ...latest.messages);
      session.pendingChanges.splice(0, session.pendingChanges.length, ...latest.pendingChanges);
      session.contextWindow = latest.contextWindow;
      session.mode = latest.mode;
      session.startTime = latest.startTime;
      session.config = { ...latest.config };
      addMessage(session, 'system', `Resumed latest session ${latest.id}`);
    },
  });

  register({
    name: 'history',
    description: 'Show recent conversation history',
    usage: '/history [count]',
    handler: async (args, session) => {
      const count = Number(args[0] ?? 10);
      const recent = session.messages.slice(-Math.max(1, Number.isFinite(count) ? count : 10));
      const text = recent.length > 0
        ? recent.map((message) => `${message.role}: ${message.content}`).join('\n')
        : 'No history yet.';
      addMessage(session, 'system', text);
    },
  });

  register({
    name: 'plan',
    description: 'Switch to planning mode',
    usage: '/plan [task]',
    handler: async (args, session) => {
      session.mode = 'plan';
      addMessage(session, 'system', args.length > 0 ? `Planning: ${args.join(' ')}` : 'Planning mode enabled.');
    },
  });

  register({
    name: 'execute',
    description: 'Switch to execute mode',
    usage: '/execute [task]',
    handler: async (args, session) => {
      session.mode = 'execute';
      addMessage(session, 'system', args.length > 0 ? `Executing: ${args.join(' ')}` : 'Execute mode enabled.');
    },
  });

  register({
    name: 'review',
    description: 'Switch to review mode',
    usage: '/review',
    handler: async (_args, session) => {
      session.mode = 'review';
      addMessage(session, 'system', 'Review mode enabled.');
    },
  });

  register({
    name: 'diff',
    description: 'Show pending changes',
    usage: '/diff',
    handler: async (_args, session) => {
      const content = session.pendingChanges.length > 0
        ? session.pendingChanges.map((change) => `${change.path} (${change.type})\n${change.diff}`).join('\n\n')
        : 'No pending changes.';
      addMessage(session, 'system', content);
    },
  });

  register({
    name: 'context',
    description: 'Show context window usage',
    usage: '/context',
    handler: async (_args, session) => {
      addMessage(session, 'system', `Context window: ${session.contextWindow}\nMessages loaded: ${session.messages.length}`);
    },
  });

  register({
    name: 'undo',
    description: 'Drop the latest pending change',
    usage: '/undo',
    handler: async (_args, session) => {
      const change = session.pendingChanges.pop();
      addMessage(session, 'system', change ? `Removed pending change ${change.path}` : 'No pending changes to remove.');
    },
  });

  for (const command of customCommands) {
    register(command);
  }

  return commands;
}

export function buildHelpText(commands: Map<string, SlashCommand>): string {
  return [...commands.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((command) => `/${command.name.padEnd(10)} ${command.description}`)
    .join('\n');
}

export async function executeSlashCommand(
  commandName: string,
  args: string[],
  context: SlashCommandContext
): Promise<boolean> {
  const command = context.commands.get(commandName);
  if (!command) {
    return false;
  }

  await command.handler(args, context.session);

  if (commandName === 'clear') {
    context.clearScreen();
  }

  if (commandName === 'save') {
    saveSession(context.session, context.persistPath);
  }

  if (commandName === 'exit' || commandName === 'quit') {
    context.exit();
  }

  return true;
}

export function createCompleter(commands: Iterable<string>): readline.Completer {
  const commandList = [...commands].map((name) => `/${name}`).sort();
  return (line: string) => {
    if (!line.startsWith('/')) {
      return [[], line];
    }
    const hits = commandList.filter((command) => command.startsWith(line));
    return [hits.length > 0 ? hits : commandList, line];
  };
}

export async function startRepl(session: ChatSession, options: StartReplOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const renderer = createRenderer(session.config.theme);
  const state = createInitialChatState();
  const commands = createSlashCommands(options.customCommands ?? []);
  const persistPath = getSessionFilePath(session.id, cwd);
  let shouldExit = false;
  let interruptCount = 0;
  let multilineBuffer: string[] = [];
  let fenceMode = false;

  const rl = readline.createInterface({
    input: (options.input ?? input) as NodeJS.ReadableStream,
    output: (options.output ?? output) as NodeJS.WritableStream,
    terminal: true,
    historySize: 200,
    removeHistoryDuplicates: true,
    completer: createCompleter(commands.keys()),
  }) as ReadlineInterface & { history: string[] };

  try {
    const historyPath = resolve(cwd, session.config.historyFile);
    if (existsSync(historyPath)) {
      rl.history.push(...readFileSync(historyPath, 'utf8').split(/\r?\n/).filter(Boolean).reverse());
    }
  } catch {
    // best-effort history load
  }

  const clearScreen = () => {
    (options.output ?? output).write('\u001bc');
  };

  const writeLine = (text = '') => {
    (options.output ?? output).write(`${text}\n`);
  };

  const commandContext: SlashCommandContext = {
    session,
    state,
    renderer,
    commands,
    customCommands: new Map((options.customCommands ?? []).map((command) => [command.name, command])),
    persistPath,
    clearScreen,
    exit: () => {
      shouldExit = true;
      rl.close();
    },
  };

  writeLine(`${colorize('JackCode', 'cyan', session.config.theme)} ${colorize('interactive chat', 'gray', session.config.theme)}`);
  writeLine(renderer.renderStatus(session, state));
  writeLine(colorize('Type /help for commands. End a line with \\ for multi-line input.', 'gray', session.config.theme));

  rl.on('SIGINT', () => {
    if (state.isProcessing && state.currentStream) {
      state.currentStream.abort();
      state.isProcessing = false;
      state.currentStream = null;
      state.lastError = 'Interrupted';
      interruptCount = 0;
      writeLine(renderer.renderError('Interrupted current request'));
      rl.prompt();
      return;
    }

    if (multilineBuffer.length > 0 || fenceMode) {
      multilineBuffer = [];
      fenceMode = false;
      interruptCount = 0;
      writeLine(colorize('Discarded multi-line draft.', 'gray', session.config.theme));
      rl.setPrompt('jackcode> ');
      rl.prompt();
      return;
    }

    interruptCount += 1;
    if (interruptCount >= 2) {
      shouldExit = true;
      rl.close();
      return;
    }

    writeLine(colorize('Press Ctrl+C again to exit.', 'gray', session.config.theme));
    rl.prompt();
  });

  const persistHistory = () => {
    try {
      const historyPath = resolve(cwd, session.config.historyFile);
      ensureParentDir(historyPath);
      writeFileSync(historyPath, [...rl.history].reverse().join('\n'), 'utf8');
    } catch {
      // best-effort history save
    }
  };

  for await (const line of rl) {
    interruptCount = 0;
    const trimmed = line.trimEnd();

    if (trimmed === '```') {
      fenceMode = !fenceMode;
      multilineBuffer.push(line);
      rl.setPrompt(fenceMode ? '... ' : 'jackcode> ');
      rl.prompt();
      continue;
    }

    if (fenceMode || trimmed.endsWith('\\')) {
      multilineBuffer.push(trimmed.endsWith('\\') ? trimmed.slice(0, -1) : line);
      rl.setPrompt('... ');
      rl.prompt();
      continue;
    }

    const rawInput = multilineBuffer.length > 0 ? [...multilineBuffer, line].join('\n').trim() : line.trim();
    multilineBuffer = [];
    fenceMode = false;
    rl.setPrompt('jackcode> ');

    if (!rawInput) {
      rl.prompt();
      continue;
    }

    const parsed = parseInput(rawInput);
    state.lastActivity = Date.now();

    if (parsed.type === 'exit') {
      shouldExit = true;
      break;
    }

    try {
      if (parsed.type === 'slash') {
        if (options.onSlashCommand) {
          await options.onSlashCommand(parsed.slashCommand ?? '', parsed.args, session);
        }

        const executed = await executeSlashCommand(parsed.slashCommand ?? '', parsed.args, commandContext);
        if (!executed) {
          throw new Error(`Unknown command: /${parsed.slashCommand}`);
        }

        const latest = session.messages[session.messages.length - 1];
        if (latest?.role === 'system') {
          writeLine(renderer.renderMessage(latest));
        }
      } else {
        addMessage(session, 'user', rawInput);
        writeLine(renderer.renderMessage(session.messages[session.messages.length - 1]!));

        state.isProcessing = true;
        state.currentStream = new AbortController();
        writeLine(renderer.renderProgress('Thinking'));

        const response = await options.onUserMessage?.(rawInput, session);
        const assistantText = typeof response === 'string'
          ? response
          : response && typeof response === 'object' && 'content' in response
            ? response.content
            : `Echo: ${rawInput}`;
        const assistantMessage = addMessage(session, 'assistant', assistantText, {
          model: session.config.defaultModel,
          latencyMs: 0,
          tokensUsed: assistantText.length,
          toolCalls: [],
        });
        writeLine(renderer.renderMessage(assistantMessage));
        state.isProcessing = false;
        state.currentStream = null;
      }

      saveSession(session, persistPath);
      persistHistory();
    } catch (error) {
      state.isProcessing = false;
      state.currentStream = null;
      state.lastError = error instanceof Error ? error.message : String(error);
      writeLine(renderer.renderError(error instanceof Error ? error : String(error)));
    }

    if (shouldExit) {
      break;
    }

    rl.prompt();
  }

  persistHistory();
  saveSession(session, persistPath);
  rl.close();

  if (!shouldExit) {
    (options.output ?? output).write('Bye.\n');
  }
}

export function resolveInputFilePath(inputPath: string, cwd = process.cwd()): string {
  return isAbsolute(inputPath) ? inputPath : resolve(cwd, inputPath);
}

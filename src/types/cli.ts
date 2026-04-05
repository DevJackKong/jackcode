/**
 * JackCode CLI Type Definitions
 */

export type ModelTier = 'qwen-3.6' | 'deepseek' | 'gpt54';

export type CLIMode = 'chat' | 'oneshot' | 'execute' | 'help' | 'version';

export type Theme = 'dark' | 'light' | 'auto';

export interface CLIConfig {
  defaultModel: ModelTier;
  theme: Theme;
  streaming: boolean;
  showTokenCount: boolean;
  historyFile: string;
}

export interface ParseResult {
  mode: CLIMode;
  config: CLIConfig;
  prompt?: string;
  flags: Record<string, string | boolean>;
}

export interface ChatSession {
  id: string;
  config: CLIConfig;
  messages: ChatMessage[];
  contextWindow: number;
  mode: SessionMode;
  pendingChanges: PendingChange[];
  startTime: number;
}

export type SessionMode = 'plan' | 'execute' | 'review' | 'idle';

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  metadata?: MessageMetadata;
}

export interface MessageMetadata {
  model?: ModelTier;
  tokensUsed?: number;
  latencyMs?: number;
  toolCalls?: ToolCall[];
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

export interface PendingChange {
  id: string;
  path: string;
  type: 'create' | 'modify' | 'delete';
  diff: string;
  applied: boolean;
}

export interface ParsedInput {
  type: InputType;
  slashCommand?: string;
  args: string[];
  raw: string;
}

export type InputType = 'chat' | 'slash' | 'file' | 'exit';

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  handler: (args: string[], session: ChatSession) => Promise<void>;
}

export interface StreamResult {
  content: string;
  tokensUsed: number;
  latencyMs: number;
  toolCalls: ToolCall[];
}

export interface StreamHandler {
  onChunk(chunk: string): void;
  onThinkingStart(): void;
  onThinkingEnd(): void;
  onComplete(result: StreamResult): void;
  onError(error: Error): void;
}

export interface RenderOptions {
  theme: Theme;
  showTimestamps: boolean;
  compact: boolean;
}

export interface ChatState {
  isProcessing: boolean;
  currentStream: AbortController | null;
  lastActivity: number;
  lastError?: string;
}

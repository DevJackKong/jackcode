import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addMessage,
  buildHelpText,
  createChatSession,
  createCompleter,
  createInitialChatState,
  createRenderer,
  createSlashCommands,
  executeSlashCommand,
  exportSession,
  formatCodeBlocks,
  formatMessage,
  getSessionFilePath,
  highlightInput,
  loadSession,
  parseInput,
  renderError,
  renderProgress,
  resumeLatestSession,
  saveSession,
} from './chat.ts';
import type { CLIConfig, SlashCommand } from '../types/cli.js';

const TEST_CONFIG: CLIConfig = {
  defaultModel: 'qwen-3.6',
  theme: 'light',
  streaming: true,
  showTokenCount: true,
  historyFile: '.jackcode/history',
};

function createSession() {
  return createChatSession({ ...TEST_CONFIG }, { id: 'session-test' });
}

test('parseInput classifies chat, slash, file, and exit input', () => {
  assert.deepEqual(parseInput('hello world'), {
    type: 'chat',
    args: ['hello world'],
    raw: 'hello world',
  });

  assert.deepEqual(parseInput('/status now'), {
    type: 'slash',
    slashCommand: 'status',
    args: ['now'],
    raw: '/status now',
  });

  assert.deepEqual(parseInput('@src/index.ts'), {
    type: 'file',
    args: ['src/index.ts'],
    raw: '@src/index.ts',
  });

  assert.deepEqual(parseInput('/quit'), {
    type: 'exit',
    args: [],
    raw: '/quit',
  });
});

test('message formatting highlights roles and code blocks', () => {
  const rendered = formatMessage(
    {
      role: 'assistant',
      content: 'Here you go:\n```ts\nconst x = 1;\n```',
      timestamp: new Date('2026-01-01T00:00:00Z').getTime(),
    },
    { theme: 'light', showTimestamps: false, compact: false }
  );

  assert.match(rendered, /ASSISTANT/);
  assert.match(rendered, /code:ts/);
  assert.match(rendered, /const x = 1/);
});

test('renderer exposes progress, status, error and input highlighting', () => {
  const session = createSession();
  addMessage(session, 'user', 'hello');
  const renderer = createRenderer('light');
  const state = createInitialChatState();

  assert.match(renderer.renderStatus(session, state), /Session session-test/);
  assert.match(renderer.renderProgress('Planning', 1, 3), /1\/3/);
  assert.match(renderer.renderError('boom'), /boom/);
  assert.equal(renderer.formatInputPreview('/help').includes('/help'), true);
});

test('slash commands include defaults and custom commands', async () => {
  const session = createSession();
  const custom: SlashCommand = {
    name: 'hello',
    description: 'Say hello',
    usage: '/hello',
    handler: async (_args, currentSession) => {
      addMessage(currentSession, 'system', 'hello custom');
    },
  };

  const commands = createSlashCommands([custom]);
  assert.equal(commands.has('help'), true);
  assert.equal(commands.has('status'), true);
  assert.equal(commands.has('hello'), true);

  const helpText = buildHelpText(commands);
  assert.match(helpText, /\/help/);
  assert.match(helpText, /\/hello/);

  const tempDir = mkdtempSync(join(tmpdir(), 'jackcode-chat-test-'));
  const persistPath = join(tempDir, 'saved.json');
  const handled = await executeSlashCommand('hello', [], {
    session,
    state: createInitialChatState(),
    renderer: createRenderer('light'),
    commands,
    customCommands: new Map([['hello', custom]]),
    persistPath,
    clearScreen: () => undefined,
    exit: () => undefined,
  });

  assert.equal(handled, true);
  assert.equal(session.messages.at(-1)?.content, 'hello custom');
  rmSync(tempDir, { recursive: true, force: true });
});

test('save/load/export and resume round-trip session state', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jackcode-session-'));
  const session = createChatSession({ ...TEST_CONFIG }, { id: 'persisted-session', mode: 'plan' });
  addMessage(session, 'user', 'build feature');
  addMessage(session, 'assistant', 'working on it');
  session.pendingChanges.push({
    id: 'c1',
    path: 'src/index.ts',
    type: 'modify',
    diff: '+ const ok = true;',
    applied: false,
  });

  const sessionPath = getSessionFilePath(session.id, tempDir);
  saveSession(session, sessionPath);
  assert.equal(existsSync(sessionPath), true);

  const loaded = loadSession(sessionPath);
  assert.equal(loaded.id, 'persisted-session');
  assert.equal(loaded.messages.length, 2);
  assert.equal(loaded.pendingChanges.length, 1);

  const exportPath = join(tempDir, 'conversation.md');
  exportSession(session, exportPath);
  const exported = readFileSync(exportPath, 'utf8');
  assert.match(exported, /JackCode Conversation Export/);
  assert.match(exported, /build feature/);

  const latest = resumeLatestSession(tempDir);
  assert.equal(latest?.id, 'persisted-session');

  rmSync(tempDir, { recursive: true, force: true });
});

test('built-in save/load/model/theme/review/history commands mutate session', async () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jackcode-slash-'));
  const sourceSession = createChatSession({ ...TEST_CONFIG }, { id: 'source-session' });
  addMessage(sourceSession, 'user', 'saved message');
  const sourcePath = join(tempDir, 'source.json');
  saveSession(sourceSession, sourcePath);

  const session = createSession();
  addMessage(session, 'assistant', 'first');
  addMessage(session, 'assistant', 'second');
  const commands = createSlashCommands();
  const ctx = {
    session,
    state: createInitialChatState(),
    renderer: createRenderer('light'),
    commands,
    customCommands: new Map(),
    persistPath: join(tempDir, 'persist.json'),
    clearScreen: () => undefined,
    exit: () => undefined,
  };

  await executeSlashCommand('model', ['deepseek'], ctx);
  assert.equal(session.config.defaultModel, 'deepseek');

  await executeSlashCommand('theme', ['dark'], ctx);
  assert.equal(session.config.theme, 'dark');

  await executeSlashCommand('review', [], ctx);
  assert.equal(session.mode, 'review');

  await executeSlashCommand('history', ['1'], ctx);
  assert.match(session.messages.at(-1)?.content ?? '', /Review mode enabled\.|assistant:/);

  await executeSlashCommand('load', [sourcePath], ctx);
  assert.equal(session.messages.some((message) => message.content === 'saved message'), true);

  await executeSlashCommand('save', [join(tempDir, 'manual-save.json')], ctx);
  assert.equal(existsSync(join(tempDir, 'manual-save.json')), true);

  rmSync(tempDir, { recursive: true, force: true });
});

test('completer suggests slash commands', () => {
  const completer = createCompleter(['help', 'history', 'status']);
  const [hits] = completer('/hi');
  assert.deepEqual(hits, ['/history']);
});

test('format helpers return readable output', () => {
  assert.match(formatCodeBlocks('```js\nconsole.log(1)\n```', 'light'), /console\.log/);
  assert.match(renderProgress('Syncing', 2, 5, 'light'), /2\/5/);
  assert.match(renderError(new Error('oops'), 'light'), /oops/);
  assert.equal(highlightInput('/save file', 'light').includes('/save file'), true);
});

test('resumeLatestSession returns null when no saved sessions exist', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'jackcode-empty-'));
  assert.equal(resumeLatestSession(tempDir), null);
  rmSync(tempDir, { recursive: true, force: true });
});

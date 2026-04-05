/**
 * Thread 05: Repo Scanner
 * Enhanced repository scanning and analysis module.
 */

import { createHash } from 'crypto';
import { promises as fs, constants } from 'fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'path';
import { execFile as execFileCb } from 'child_process';
import { promisify } from 'util';
import type {
  ScannerConfig,
  ScanOptions,
  FileIndex,
  FileEntry,
  DirectoryEntry,
  LanguageStats,
  GitInfo,
  GitFileStatus,
  Commit,
  RepoStats,
  FileStats,
  FileChange,
  FileChangeCallback,
  DependencyInfo,
  LanguageDetection,
  ScanResult,
  ScanError,
  IgnoreConfig,
} from '../types/scanner.js';

const execFile = promisify(execFileCb);

const DEFAULT_CONFIG: Partial<ScannerConfig> = {
  include: ['**/*'],
  exclude: [],
  respectGitignore: true,
  maxFileSize: 10 * 1024 * 1024,
  followSymlinks: false,
  maxDepth: 50,
};

const DEFAULT_EXCLUDED_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.pnpm-store',
  'vendor',
  'target',
  '.idea',
]);

const KNOWN_CONFIG_FILES = new Map<string, string>([
  ['dockerfile', 'docker'],
  ['makefile', 'make'],
  ['justfile', 'make'],
  ['compose.yml', 'yaml'],
  ['compose.yaml', 'yaml'],
  ['.env', 'dotenv'],
  ['.env.example', 'dotenv'],
  ['.npmrc', 'ini'],
  ['.yarnrc', 'yaml'],
  ['.yarnrc.yml', 'yaml'],
  ['tsconfig.json', 'json'],
  ['package.json', 'json'],
  ['pnpm-workspace.yaml', 'yaml'],
  ['vite.config.ts', 'typescript'],
  ['vite.config.js', 'javascript'],
  ['vitest.config.ts', 'typescript'],
  ['vitest.config.js', 'javascript'],
  ['jest.config.ts', 'typescript'],
  ['jest.config.js', 'javascript'],
  ['webpack.config.js', 'javascript'],
  ['webpack.config.ts', 'typescript'],
  ['rollup.config.js', 'javascript'],
  ['rollup.config.ts', 'typescript'],
  ['tailwind.config.js', 'javascript'],
  ['tailwind.config.ts', 'typescript'],
  ['eslint.config.js', 'javascript'],
  ['eslint.config.ts', 'typescript'],
  ['.eslintrc', 'json'],
  ['.prettierrc', 'json'],
  ['requirements.txt', 'text'],
  ['cargo.toml', 'toml'],
  ['go.mod', 'go'],
  ['gemfile', 'ruby'],
  ['pyproject.toml', 'toml'],
]);

const EXTENSION_TO_LANGUAGE: Map<string, string> = new Map([
  ['ts', 'typescript'], ['tsx', 'typescript'],
  ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['py', 'python'], ['pyi', 'python'],
  ['rb', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'], ['kts', 'kotlin'],
  ['swift', 'swift'],
  ['cpp', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'], ['hh', 'cpp'],
  ['h', 'c'], ['c', 'c'],
  ['cs', 'csharp'],
  ['php', 'php'],
  ['sh', 'shell'], ['bash', 'shell'], ['zsh', 'shell'], ['fish', 'shell'],
  ['ps1', 'powershell'],
  ['pl', 'perl'], ['pm', 'perl'],
  ['lua', 'lua'],
  ['r', 'r'],
  ['scala', 'scala'], ['sc', 'scala'],
  ['groovy', 'groovy'],
  ['dart', 'dart'],
  ['elm', 'elm'],
  ['erl', 'erlang'], ['hrl', 'erlang'],
  ['ex', 'elixir'], ['exs', 'elixir'],
  ['fs', 'fsharp'], ['fsx', 'fsharp'],
  ['hs', 'haskell'], ['lhs', 'haskell'],
  ['jl', 'julia'],
  ['ml', 'ocaml'], ['mli', 'ocaml'],
  ['nim', 'nim'],
  ['cr', 'crystal'],
  ['clj', 'clojure'], ['cljs', 'clojure'], ['cljc', 'clojure'],
  ['coffee', 'coffeescript'],
  ['purs', 'purescript'],
  ['re', 'reason'], ['rei', 'reason'],
  ['v', 'v'],
  ['zig', 'zig'],
  ['md', 'markdown'], ['mdx', 'markdown'],
  ['json', 'json'], ['jsonc', 'json'],
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['toml', 'toml'],
  ['xml', 'xml'], ['svg', 'xml'],
  ['sql', 'sql'],
  ['html', 'html'], ['htm', 'html'],
  ['css', 'css'], ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['astro', 'astro'],
  ['sol', 'solidity'],
  ['vy', 'vyper'],
  ['graphql', 'graphql'], ['gql', 'graphql'],
  ['proto', 'protobuf'],
  ['ini', 'ini'], ['conf', 'config'], ['cfg', 'config'],
]);

const LANGUAGE_TO_EXTENSIONS: Map<string, string[]> = new Map();
for (const [ext, lang] of EXTENSION_TO_LANGUAGE) {
  const exts = LANGUAGE_TO_EXTENSIONS.get(lang) || [];
  exts.push(ext);
  LANGUAGE_TO_EXTENSIONS.set(lang, exts);
}

interface ScanFilterOptions {
  minSize?: number;
  maxSize?: number;
  minAgeMs?: number;
  maxAgeMs?: number;
  ignoreRegex?: RegExp[];
  customFilter?: (absolutePath: string, relativePath: string, stats: { size: number; mtimeMs: number; ctimeMs: number; isDirectory: boolean; }) => boolean;
}

interface FileCacheEntry {
  statKey: string;
  entry: FileEntry;
  content?: string;
  sample?: Buffer;
  dependencies?: DependencyInfo[];
  imports?: string[];
}

interface ScanRuntimeContext {
  files: Map<string, FileEntry>;
  directories: Map<string, DirectoryEntry>;
  languages: Map<string, LanguageStats>;
  errors: ScanError[];
  dependencies: DependencyInfo[];
  dependencyManifests: string[];
  importGraph: Map<string, string[]>;
  frameworks: Set<string>;
  circularDependencies: string[][];
  ignoredPatterns: string[];
  processed: number;
  changedFiles: FileChange[];
  deletedFiles: string[];
  benchmark: RepoBenchmark;
}

interface GitBlameSummary {
  path: string;
  authors: string[];
  primaryAuthor?: string;
  lineCount: number;
}

interface FileHistorySummary {
  path: string;
  commits: Commit[];
}

interface GitComparisonSummary {
  base: string;
  target: string;
  changedFiles: string[];
  ahead: number;
  behind: number;
}

interface RepoBenchmark {
  totalDurationMs: number;
  traversalDurationMs: number;
  fileProcessingDurationMs: number;
  gitDurationMs: number;
  dependencyDurationMs: number;
  fileCount: number;
  cacheHits: number;
  cacheMisses: number;
}

function toPosixPath(pathValue: string): string {
  return pathValue.split(sep).join('/');
}

function makeStatKey(stats: { size: number; mtimeMs: number; ctimeMs: number }): string {
  return `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

function normalizeIncludePatterns(patterns: string[] | undefined): string[] {
  if (!patterns || patterns.length === 0) return ['**/*'];
  return patterns;
}

function globToRegExp(pattern: string): RegExp {
  const normalized = toPosixPath(pattern)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.');
  const regexBody = normalized.replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${regexBody}$`);
}

function matchesAnyGlob(pathValue: string, patterns: string[]): boolean {
  if (patterns.length === 0) return true;
  const normalized = toPosixPath(pathValue);
  return patterns.some((pattern) => {
    const plain = toPosixPath(pattern);
    if (plain === '**/*') return true;
    if (plain === normalized) return true;
    if (!plain.includes('*') && !plain.includes('?')) {
      return normalized === plain || normalized.startsWith(`${plain}/`);
    }
    return globToRegExp(plain).test(normalized);
  });
}

function stableArray<T>(values: Iterable<T>): T[] {
  return Array.from(values).sort((a, b) => String(a).localeCompare(String(b)));
}

function extractJsonObject(content: string): Record<string, unknown> | null {
  try {
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function calculateFileStats(content: string, language: string | null): FileStats {
  const lines = content.split('\n');
  let codeLines = 0;
  let commentLines = 0;
  let blankLines = 0;
  let inBlockComment = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === '') {
      blankLines++;
      continue;
    }

    const lang = language || '';
    const isCStyle = ['typescript', 'javascript', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin', 'php', 'css', 'scss', 'sass'].includes(lang);
    const isHashStyle = ['python', 'shell', 'ruby', 'perl', 'yaml', 'toml', 'make'].includes(lang);
    const isMarkup = ['html', 'xml'].includes(lang);

    if (isCStyle) {
      if (inBlockComment) {
        commentLines++;
        if (trimmed.includes('*/')) inBlockComment = false;
      } else if (trimmed.startsWith('//')) {
        commentLines++;
      } else if (trimmed.startsWith('/*')) {
        commentLines++;
        if (!trimmed.includes('*/')) inBlockComment = true;
      } else {
        codeLines++;
      }
    } else if (isHashStyle) {
      if (trimmed.startsWith('#')) commentLines++;
      else codeLines++;
    } else if (isMarkup) {
      if (trimmed.startsWith('<!--') || trimmed.startsWith('<?')) commentLines++;
      else codeLines++;
    } else {
      codeLines++;
    }
  }

  return {
    totalLines: lines.length,
    codeLines,
    commentLines,
    blankLines,
  };
}

async function parseGitignore(rootDir: string): Promise<string[]> {
  const gitignorePath = join(rootDir, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('#'));
  } catch {
    return [];
  }
}

function buildIgnoreMatchers(patterns: string[]): RegExp[] {
  return patterns
    .filter((pattern) => pattern && !pattern.startsWith('!'))
    .map((pattern) => {
      const normalized = toPosixPath(pattern);
      if (!normalized.includes('*') && !normalized.includes('?')) {
        const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`(^|/)${escaped}($|/)`);
      }
      return globToRegExp(normalized.replace(/\/$/, '/**'));
    });
}

function matchesIgnorePatterns(pathValue: string, matchers: RegExp[]): boolean {
  const normalized = toPosixPath(pathValue);
  return matchers.some((matcher) => matcher.test(normalized));
}

function detectTestFile(relativePath: string): boolean {
  const normalized = toPosixPath(relativePath).toLowerCase();
  return (
    normalized.includes('/__tests__/') ||
    normalized.includes('/test/') ||
    normalized.includes('/tests/') ||
    /(?:\.|-|_)(test|spec)\.[^.]+$/.test(normalized)
  );
}

function detectConfigFile(relativePath: string): boolean {
  const lower = basename(relativePath).toLowerCase();
  return KNOWN_CONFIG_FILES.has(lower) || lower.startsWith('.') || /config\.[^.]+$/.test(lower);
}

function extractFrameworks(relativePath: string, content: string): string[] {
  const frameworks = new Set<string>();
  const file = basename(relativePath).toLowerCase();
  if (file === 'package.json') {
    const pkg = extractJsonObject(content);
    const deps = {
      ...(typeof pkg?.dependencies === 'object' && pkg.dependencies ? pkg.dependencies as Record<string, string> : {}),
      ...(typeof pkg?.devDependencies === 'object' && pkg.devDependencies ? pkg.devDependencies as Record<string, string> : {}),
    };
    const known: Record<string, string> = {
      react: 'react',
      next: 'nextjs',
      vue: 'vue',
      nuxt: 'nuxt',
      svelte: 'svelte',
      '@angular/core': 'angular',
      express: 'express',
      koa: 'koa',
      fastify: 'fastify',
      nestjs: 'nestjs',
      '@nestjs/core': 'nestjs',
      vitest: 'vitest',
      jest: 'jest',
      mocha: 'mocha',
      pytest: 'pytest',
      django: 'django',
      flask: 'flask',
      fastapi: 'fastapi',
    };
    for (const [depName, framework] of Object.entries(known)) {
      if (depName in deps) frameworks.add(framework);
    }
  }

  const normalized = toPosixPath(relativePath).toLowerCase();
  if (normalized.endsWith('.vue')) frameworks.add('vue');
  if (normalized.endsWith('.svelte')) frameworks.add('svelte');
  if (normalized.endsWith('.astro')) frameworks.add('astro');
  if (normalized.endsWith('.tsx') || normalized.endsWith('.jsx')) frameworks.add('react');
  if (/from\s+['"]react['"]/.test(content) || /require\(['"]react['"]\)/.test(content)) frameworks.add('react');
  if (file === 'next.config.js' || file === 'next.config.mjs' || file === 'next.config.ts') frameworks.add('nextjs');
  if (file === 'nuxt.config.ts' || file === 'nuxt.config.js') frameworks.add('nuxt');
  return stableArray(frameworks);
}

function extractImports(language: string | null, content: string): string[] {
  if (!language) return [];
  const imports = new Set<string>();
  const patterns: RegExp[] = [];

  if (['typescript', 'javascript', 'vue', 'svelte', 'astro'].includes(language)) {
    patterns.push(/import\s+(?:[^'";]+\s+from\s+)?['"]([^'"]+)['"]/g);
    patterns.push(/export\s+.*?from\s+['"]([^'"]+)['"]/g);
    patterns.push(/require\(['"]([^'"]+)['"]\)/g);
  }
  if (language === 'python') {
    patterns.push(/from\s+([\w.]+)\s+import\s+/g);
    patterns.push(/import\s+([\w.]+)/g);
  }
  if (language === 'go') {
    patterns.push(/import\s+"([^"]+)"/g);
  }
  if (language === 'rust') {
    patterns.push(/use\s+([\w:]+)::/g);
  }

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) imports.add(match[1]);
    }
  }

  return stableArray(imports);
}

function resolveLocalImport(sourcePath: string, target: string, files: Map<string, FileEntry>): string | null {
  if (!target.startsWith('.') && !target.startsWith('/')) return null;
  const sourceDir = dirname(sourcePath);
  const candidateBase = toPosixPath(target.startsWith('/') ? target.slice(1) : join(sourceDir, target));
  const candidates = new Set<string>([
    candidateBase,
    `${candidateBase}.ts`, `${candidateBase}.tsx`, `${candidateBase}.js`, `${candidateBase}.jsx`,
    `${candidateBase}.mjs`, `${candidateBase}.cjs`, `${candidateBase}.py`, `${candidateBase}.go`,
    `${candidateBase}.rs`, `${candidateBase}.vue`, `${candidateBase}.svelte`, `${candidateBase}.astro`,
    `${candidateBase}/index.ts`, `${candidateBase}/index.tsx`, `${candidateBase}/index.js`, `${candidateBase}/index.jsx`,
  ]);

  for (const candidate of candidates) {
    if (files.has(candidate)) return candidate;
  }
  return null;
}

function detectCircularDependencies(graph: Map<string, string[]>): string[][] {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const cycles = new Set<string>();

  const walk = (node: string): void => {
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);

    for (const next of graph.get(node) || []) {
      if (!graph.has(next)) continue;
      if (visiting.has(next)) {
        const cycle = stack.slice(stack.indexOf(next)).concat(next);
        cycles.add(cycle.join(' -> '));
      } else {
        walk(next);
      }
    }

    stack.pop();
    visiting.delete(node);
    visited.add(node);
  };

  for (const node of stableArray(graph.keys())) walk(node);
  return stableArray(cycles).map((cycle) => cycle.split(' -> '));
}

function parseVersionConstraint(version: string): { raw: string; operator: string; exact?: string } {
  const trimmed = version.trim();
  const match = trimmed.match(/^([~^<>=!]+)?\s*(.+)$/);
  return {
    raw: version,
    operator: match?.[1] || (trimmed === '*' ? '*' : '='),
    exact: match?.[2] || undefined,
  };
}

async function statSafe(pathValue: string) {
  try {
    return await fs.stat(pathValue);
  } catch {
    return null;
  }
}

async function listFilesRecursive(rootDir: string): Promise<string[]> {
  const results: string[] = [];
  const queue = [''];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const currentAbs = join(rootDir, current);
    const entries = await fs.readdir(currentAbs, { withFileTypes: true });
    for (const entry of entries) {
      const rel = current ? `${current}/${entry.name}` : entry.name;
      if (entry.isDirectory()) queue.push(rel);
      else if (entry.isFile()) results.push(rel);
    }
  }
  return stableArray(results);
}

export class LanguageDetector {
  detect(filePath: string, content?: string): LanguageDetection {
    const fileName = basename(filePath).toLowerCase();
    const ext = extname(filePath).toLowerCase().slice(1);

    const configLang = KNOWN_CONFIG_FILES.get(fileName);
    if (configLang) return { language: configLang, confidence: 0.95, method: 'extension' };

    if (ext) {
      const lang = EXTENSION_TO_LANGUAGE.get(ext);
      if (lang) return { language: lang, confidence: 0.9, method: 'extension' };
    }

    if (content) {
      const shebangLang = this.detectByShebang(content);
      if (shebangLang) return { language: shebangLang, confidence: 0.85, method: 'shebang' };
      const contentLang = this.detectByContent(content);
      if (contentLang) return { language: contentLang, confidence: 0.8, method: 'content' };
    }

    return { language: null, confidence: 0, method: 'none' };
  }

  detectByExtension(extension: string): string | null {
    return EXTENSION_TO_LANGUAGE.get(extension.toLowerCase().replace(/^\./, '')) || null;
  }

  detectByContent(content: string): string | null {
    if (content.includes('<?php')) return 'php';
    if (content.includes('<?xml')) return 'xml';
    if (content.includes('package main')) return 'go';
    if (/^\s*fn\s+main\s*\(/m.test(content)) return 'rust';
    if (/^\s*def\s+\w+\s*\(/m.test(content) || /^\s*from\s+\w+\s+import\s+/m.test(content)) return 'python';
    if (/^\s*import\s+.+from\s+['"]/m.test(content) || /^\s*export\s+/m.test(content)) return 'javascript';
    if (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) {
      try {
        JSON.parse(content);
        return 'json';
      } catch {
        // ignore
      }
    }
    return null;
  }

  private detectByShebang(content: string): string | null {
    const firstLine = content.split('\n', 1)[0]?.trim() || '';
    if (!firstLine.startsWith('#!')) return null;
    const line = firstLine.toLowerCase();
    if (line.includes('python')) return 'python';
    if (line.includes('node')) return 'javascript';
    if (line.includes('ruby')) return 'ruby';
    if (line.includes('bash') || line.includes('/sh')) return 'shell';
    if (line.includes('perl')) return 'perl';
    if (line.includes('lua')) return 'lua';
    return null;
  }

  getExtensions(language: string): string[] {
    return LANGUAGE_TO_EXTENSIONS.get(language.toLowerCase()) || [];
  }

  isTextFile(filePath: string, sample?: Buffer): boolean {
    const binaryExtensions = new Set([
      'exe', 'dll', 'so', 'dylib', 'bin', 'jpg', 'jpeg', 'png', 'gif', 'bmp', 'ico', 'webp',
      'mp3', 'mp4', 'wav', 'ogg', 'webm', 'zip', 'tar', 'gz', 'bz2', '7z', 'rar', 'pdf',
      'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'db', 'sqlite', 'sqlite3', 'woff', 'woff2',
      'ttf', 'otf', 'eot', 'wasm', 'class', 'o', 'a', 'lib',
    ]);
    const ext = extname(filePath).toLowerCase().slice(1);
    if (binaryExtensions.has(ext)) return false;
    if (sample) {
      for (let i = 0; i < Math.min(sample.length, 4096); i++) {
        if (sample[i] === 0) return false;
      }
    }
    return true;
  }
}

export class RepoScanner {
  private config: Required<ScannerConfig>;
  private index: FileIndex | null = null;
  private languageDetector: LanguageDetector;
  private ignorePatterns: string[] = [];
  private ignoreMatchers: RegExp[] = [];
  private watchCallbacks: Set<FileChangeCallback> = new Set();
  private isWatching = false;
  private fileCache = new Map<string, FileCacheEntry>();
  private lastBenchmark: RepoBenchmark | null = null;

  constructor(config: ScannerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<ScannerConfig>;
    this.languageDetector = new LanguageDetector();
  }

  async scan(options: ScanOptions & ScanFilterOptions = {}): Promise<ScanResult> {
    const startedAt = Date.now();
    const benchmark: RepoBenchmark = {
      totalDurationMs: 0,
      traversalDurationMs: 0,
      fileProcessingDurationMs: 0,
      gitDurationMs: 0,
      dependencyDurationMs: 0,
      fileCount: 0,
      cacheHits: 0,
      cacheMisses: 0,
    };

    const runtime: ScanRuntimeContext = {
      files: new Map(),
      directories: new Map(),
      languages: new Map(),
      errors: [],
      dependencies: [],
      dependencyManifests: [],
      importGraph: new Map(),
      frameworks: new Set(),
      circularDependencies: [],
      ignoredPatterns: [],
      processed: 0,
      changedFiles: [],
      deletedFiles: [],
      benchmark,
    };

    try {
      await this.loadIgnorePatterns();
      runtime.ignoredPatterns = [...this.ignorePatterns];

      const traversalStart = Date.now();
      await this.scanPaths(runtime, options);
      benchmark.traversalDurationMs = Date.now() - traversalStart;

      const dependencyStart = Date.now();
      this.finalizeDependencyGraph(runtime);
      benchmark.dependencyDurationMs = Date.now() - dependencyStart;

      const gitStart = Date.now();
      const gitInfo = await this.getGitInfo();
      benchmark.gitDurationMs = Date.now() - gitStart;

      const index = {
        rootDir: this.config.rootDir,
        files: runtime.files,
        directories: runtime.directories,
        languages: runtime.languages,
        generatedAt: Date.now(),
        gitInfo,
        dependencies: runtime.dependencies,
        dependencyManifests: runtime.dependencyManifests,
        importGraph: runtime.importGraph,
        circularDependencies: runtime.circularDependencies,
        frameworks: stableArray(runtime.frameworks),
        ignoredPatterns: runtime.ignoredPatterns,
        benchmark,
        changes: runtime.changedFiles,
      } as FileIndex & Record<string, unknown>;

      this.pruneCache(runtime.files);
      this.index = index as FileIndex;
      benchmark.fileCount = runtime.files.size;
      benchmark.totalDurationMs = Date.now() - startedAt;
      this.lastBenchmark = benchmark;

      return {
        success: true,
        index: this.index,
        filesProcessed: runtime.files.size,
        durationMs: benchmark.totalDurationMs,
        errors: runtime.errors,
      };
    } catch (error) {
      benchmark.totalDurationMs = Date.now() - startedAt;
      this.lastBenchmark = benchmark;
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        filesProcessed: runtime.files.size,
        durationMs: benchmark.totalDurationMs,
        errors: runtime.errors,
      };
    }
  }

  private async scanPaths(runtime: ScanRuntimeContext, options: ScanOptions & ScanFilterOptions): Promise<void> {
    const targetPaths = options.paths && options.paths.length > 0 ? stableArray(new Set(options.paths.map((item) => toPosixPath(item)))) : [''];
    const includePatterns = normalizeIncludePatterns(this.config.include);

    const walk = async (absolutePath: string, relativePath: string, depth: number): Promise<void> => {
      if (depth > this.config.maxDepth) return;
      if (relativePath && matchesIgnorePatterns(relativePath, this.ignoreMatchers)) return;

      const stats = await statSafe(absolutePath);
      if (!stats) return;

      const filterStats = {
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        ctimeMs: stats.ctimeMs,
        isDirectory: stats.isDirectory(),
      };
      if (!this.applyFilters(absolutePath, relativePath, filterStats, options)) return;

      if (stats.isDirectory()) {
        const dirName = basename(relativePath || absolutePath);
        if (relativePath && DEFAULT_EXCLUDED_DIRS.has(dirName)) return;

        const entries = await fs.readdir(absolutePath, { withFileTypes: true });
        const filePaths: string[] = [];
        const subdirs: string[] = [];
        const tasks = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(async (entry) => {
            const childRel = relativePath ? `${relativePath}/${entry.name}` : entry.name;
            const childAbs = join(absolutePath, entry.name);
            if (matchesIgnorePatterns(childRel, this.ignoreMatchers)) return;
            if (!matchesAnyGlob(childRel, includePatterns) && !entry.isDirectory()) return;

            if (entry.isDirectory()) {
              subdirs.push(childRel);
              await walk(childAbs, childRel, depth + 1);
            } else if (entry.isFile()) {
              const childStats = await statSafe(childAbs);
              if (!childStats || !this.applyFilters(childAbs, childRel, {
                size: childStats.size,
                mtimeMs: childStats.mtimeMs,
                ctimeMs: childStats.ctimeMs,
                isDirectory: false,
              }, options)) return;
              filePaths.push(childRel);
              await this.processFile(childAbs, childRel, runtime, options);
            } else if (entry.isSymbolicLink() && this.config.followSymlinks) {
              const linkStats = await statSafe(childAbs);
              if (linkStats?.isDirectory()) {
                subdirs.push(childRel);
                await walk(childAbs, childRel, depth + 1);
              } else if (linkStats?.isFile()) {
                filePaths.push(childRel);
                await this.processFile(childAbs, childRel, runtime, options);
              }
            }
          });

        await Promise.all(tasks);

        const size = filePaths.reduce((sum, filePath) => sum + (runtime.files.get(filePath)?.size || 0), 0);
        runtime.directories.set(relativePath, {
          path: relativePath,
          absolutePath,
          files: stableArray(filePaths),
          subdirectories: stableArray(subdirs),
          size,
          modifiedAt: stats.mtimeMs,
        });
        return;
      }

      if (stats.isFile()) {
        await this.processFile(absolutePath, relativePath, runtime, options);
      }
    };

    for (const relPath of targetPaths) {
      const absPath = join(this.config.rootDir, relPath);
      await walk(absPath, relPath, 0);
    }

    if (this.index && (!options.paths || options.paths.length === 0)) {
      const previousPaths = new Set(this.index.files.keys());
      for (const current of runtime.files.keys()) previousPaths.delete(current);
      runtime.deletedFiles = stableArray(previousPaths);
      for (const deleted of runtime.deletedFiles) {
        runtime.changedFiles.push({ path: deleted, type: 'deleted' });
      }
    }
  }

  private applyFilters(
    absolutePath: string,
    relativePath: string,
    stats: { size: number; mtimeMs: number; ctimeMs: number; isDirectory: boolean },
    options: ScanOptions & ScanFilterOptions,
  ): boolean {
    if (options.ignoreRegex?.some((regex) => regex.test(relativePath || absolutePath))) return false;
    if (stats.isDirectory) return options.customFilter ? options.customFilter(absolutePath, relativePath, stats) : true;
    if (typeof options.minSize === 'number' && stats.size < options.minSize) return false;
    if (typeof options.maxSize === 'number' && stats.size > options.maxSize) return false;
    const ageMs = Date.now() - stats.mtimeMs;
    if (typeof options.minAgeMs === 'number' && ageMs < options.minAgeMs) return false;
    if (typeof options.maxAgeMs === 'number' && ageMs > options.maxAgeMs) return false;
    if (options.customFilter && !options.customFilter(absolutePath, relativePath, stats)) return false;
    return true;
  }

  private async processFile(absolutePath: string, relativePath: string, runtime: ScanRuntimeContext, options: ScanOptions): Promise<void> {
    const startedAt = Date.now();
    try {
      const stats = await fs.stat(absolutePath);
      if (this.config.maxFileSize && stats.size > this.config.maxFileSize) return;

      const statKey = makeStatKey(stats);
      const cached = !options.force ? this.fileCache.get(relativePath) : undefined;
      if (cached && cached.statKey === statKey) {
        runtime.files.set(relativePath, cached.entry);
        this.mergeLanguageStats(runtime.languages, cached.entry);
        if (cached.dependencies) runtime.dependencies.push(...cached.dependencies);
        if (cached.dependencies && cached.dependencies.length > 0) runtime.dependencyManifests.push(relativePath);
        if (cached.imports) runtime.importGraph.set(relativePath, cached.imports);
        for (const framework of ((cached.entry as Record<string, unknown>).frameworks as string[] | undefined) || []) {
          runtime.frameworks.add(framework);
        }
        runtime.benchmark.cacheHits++;
        runtime.processed++;
        return;
      }

      runtime.benchmark.cacheMisses++;
      const buffer = await fs.readFile(absolutePath);
      const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
      const isText = this.languageDetector.isTextFile(absolutePath, sample);
      const content = isText ? buffer.toString('utf8') : '';
      const contentHash = createHash('sha256').update(buffer).digest('hex');
      const detection = this.languageDetector.detect(relativePath, content || undefined);
      const language = detection.language;
      const fileStats = isText ? calculateFileStats(content, language) : { totalLines: 0, codeLines: 0, commentLines: 0, blankLines: 0 };
      const testFile = detectTestFile(relativePath);
      const configFile = detectConfigFile(relativePath);
      const frameworks = isText ? extractFrameworks(relativePath, content) : [];
      const imports = isText ? extractImports(language, content) : [];
      const gitStatus = await this.getFileGitStatus(relativePath);

      const fileEntry = {
        path: relativePath,
        absolutePath,
        name: basename(relativePath),
        extension: extname(relativePath).toLowerCase().slice(1),
        language,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        createdAt: stats.ctimeMs,
        contentHash,
        lines: fileStats.totalLines,
        stats: fileStats,
        gitStatus,
        isBinary: !isText,
        isTest: testFile,
        isConfig: configFile,
        frameworks,
        imports,
      } as FileEntry & Record<string, unknown>;

      runtime.files.set(relativePath, fileEntry as FileEntry);
      this.mergeLanguageStats(runtime.languages, fileEntry as FileEntry);
      for (const framework of frameworks) runtime.frameworks.add(framework);
      runtime.importGraph.set(relativePath, imports);

      const deps = await this.extractManifestDependencies(relativePath, absolutePath, content, language);
      if (deps.length > 0) {
        runtime.dependencies.push(...deps);
        runtime.dependencyManifests.push(relativePath);
      }

      const previous = this.index?.files.get(relativePath);
      if (!previous) {
        runtime.changedFiles.push({ path: relativePath, type: 'added', currentHash: contentHash });
      } else if (previous.contentHash !== contentHash) {
        runtime.changedFiles.push({ path: relativePath, type: 'modified', previousHash: previous.contentHash, currentHash: contentHash });
      }

      this.fileCache.set(relativePath, {
        statKey,
        entry: fileEntry as FileEntry,
        content: isText ? content : undefined,
        sample,
        dependencies: deps,
        imports,
      });
      runtime.processed++;
    } catch (error) {
      runtime.errors.push({
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      runtime.benchmark.fileProcessingDurationMs += Date.now() - startedAt;
    }
  }

  private mergeLanguageStats(languages: Map<string, LanguageStats>, fileEntry: FileEntry): void {
    if (!fileEntry.language) return;
    const current = languages.get(fileEntry.language) || {
      language: fileEntry.language,
      fileCount: 0,
      totalLines: 0,
      codeLines: 0,
      commentLines: 0,
      blankLines: 0,
      extensions: this.languageDetector.getExtensions(fileEntry.language),
      totalSize: 0,
    };
    current.fileCount += 1;
    current.totalLines += fileEntry.stats.totalLines;
    current.codeLines += fileEntry.stats.codeLines;
    current.commentLines += fileEntry.stats.commentLines;
    current.blankLines += fileEntry.stats.blankLines;
    current.totalSize += fileEntry.size;
    languages.set(fileEntry.language, current);
  }

  private async extractManifestDependencies(relativePath: string, absolutePath: string, content: string, language: string | null): Promise<DependencyInfo[]> {
    const fileName = basename(relativePath).toLowerCase();
    if (!content || !(fileName === 'package.json' || fileName === 'cargo.toml' || fileName === 'requirements.txt' || fileName === 'go.mod' || fileName === 'gemfile' || fileName === 'pyproject.toml')) {
      return [];
    }
    const parser = new DependencyParser();
    const dependencies = await parser.parse(absolutePath);
    return dependencies.map((dep) => ({
      ...dep,
      source: relativePath,
      versionConstraint: parseVersionConstraint(dep.version),
      ecosystem: this.getDependencyEcosystem(fileName, language),
    } as DependencyInfo & Record<string, unknown>));
  }

  private getDependencyEcosystem(fileName: string, language: string | null): string {
    if (fileName === 'package.json') return 'npm';
    if (fileName === 'requirements.txt' || fileName === 'pyproject.toml' || language === 'python') return 'python';
    if (fileName === 'cargo.toml') return 'rust';
    if (fileName === 'go.mod') return 'go';
    if (fileName === 'gemfile') return 'ruby';
    return 'unknown';
  }

  private finalizeDependencyGraph(runtime: ScanRuntimeContext): void {
    const resolvedGraph = new Map<string, string[]>();
    for (const [source, imports] of runtime.importGraph.entries()) {
      const resolved = imports
        .map((item) => resolveLocalImport(source, item, runtime.files))
        .filter((item): item is string => Boolean(item));
      resolvedGraph.set(source, stableArray(new Set(resolved)));
    }
    runtime.circularDependencies = detectCircularDependencies(resolvedGraph);
    for (const [source, deps] of resolvedGraph.entries()) runtime.importGraph.set(source, deps);

    const declared = new Map<string, DependencyInfo[]>();
    for (const dep of runtime.dependencies) {
      const items = declared.get(dep.name) || [];
      items.push(dep);
      declared.set(dep.name, items);
    }

    const used = new Set<string>();
    for (const imports of runtime.importGraph.values()) {
      for (const item of imports) {
        if (!item.startsWith('.')) used.add(item.split('/')[0].replace(/^@([^/]+)$/, '@$1'));
      }
    }

    runtime.dependencies = runtime.dependencies.map((dep) => ({
      ...dep,
      unused: !used.has(dep.name) && !used.has(dep.name.split('/')[0]),
      occurrences: declared.get(dep.name)?.length || 1,
    } as DependencyInfo & Record<string, unknown>));
  }

  private async loadIgnorePatterns(): Promise<void> {
    const patterns = new Set<string>([...DEFAULT_EXCLUDED_DIRS]);
    if (this.config.respectGitignore) {
      for (const pattern of await parseGitignore(this.config.rootDir)) patterns.add(pattern);
    }
    for (const pattern of this.config.exclude || []) patterns.add(pattern);
    this.ignorePatterns = stableArray(patterns);
    this.ignoreMatchers = buildIgnoreMatchers(this.ignorePatterns);
  }

  private pruneCache(files: Map<string, FileEntry>): void {
    const active = new Set(files.keys());
    for (const pathValue of this.fileCache.keys()) {
      if (!active.has(pathValue)) this.fileCache.delete(pathValue);
    }
  }

  private async runGit(args: string[]): Promise<string | null> {
    try {
      const { stdout } = await execFile('git', args, { cwd: this.config.rootDir, maxBuffer: 8 * 1024 * 1024 });
      return stdout.trim();
    } catch {
      return null;
    }
  }

  private async getFileGitStatus(relativePath: string): Promise<GitFileStatus> {
    const output = await this.runGit(['status', '--porcelain', '--', relativePath]);
    if (output == null) return 'unmodified';
    if (!output) return 'unmodified';
    const code = output.slice(0, 2);
    if (code.includes('U')) return 'conflict';
    if (code === '??') return 'untracked';
    if (code[0] !== ' ' && code[0] !== '?') return 'staged';
    if (code[1] !== ' ') return 'modified';
    return 'unmodified';
  }

  private async getGitInfo(): Promise<GitInfo | undefined> {
    const gitDir = join(this.config.rootDir, '.git');
    try {
      await fs.access(gitDir, constants.R_OK);
    } catch {
      return {
        isRepo: false,
        currentBranch: '',
        untrackedFiles: [],
        modifiedFiles: [],
        stagedFiles: [],
        conflictFiles: [],
      };
    }

    const [branch, head, remoteUrl, status, aheadBehind, lastCommitRaw] = await Promise.all([
      this.runGit(['branch', '--show-current']),
      this.runGit(['rev-parse', 'HEAD']),
      this.runGit(['remote', 'get-url', 'origin']),
      this.runGit(['status', '--porcelain']),
      this.runGit(['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']),
      this.runGit(['log', '-1', '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%s%x1f%at']),
    ]);

    const modifiedFiles: string[] = [];
    const stagedFiles: string[] = [];
    const untrackedFiles: string[] = [];
    const conflictFiles: string[] = [];

    if (status) {
      for (const line of status.split('\n')) {
        if (!line.trim()) continue;
        const code = line.slice(0, 2);
        const file = line.slice(3).trim();
        if (code === '??') untrackedFiles.push(file);
        else if (code.includes('U')) conflictFiles.push(file);
        else {
          if (code[0] !== ' ') stagedFiles.push(file);
          if (code[1] !== ' ') modifiedFiles.push(file);
        }
      }
    }

    let ahead = 0;
    let behind = 0;
    if (aheadBehind) {
      const parts = aheadBehind.split(/\s+/).map((value) => Number.parseInt(value, 10));
      ahead = Number.isFinite(parts[0]) ? parts[0] : 0;
      behind = Number.isFinite(parts[1]) ? parts[1] : 0;
    }

    const headCommit = lastCommitRaw ? this.parseCommitLine(lastCommitRaw) : undefined;

    return {
      isRepo: true,
      rootPath: this.config.rootDir,
      currentBranch: branch || '',
      headCommit,
      remoteUrl: remoteUrl || undefined,
      ahead,
      behind,
      untrackedFiles: stableArray(untrackedFiles),
      modifiedFiles: stableArray(modifiedFiles),
      stagedFiles: stableArray(stagedFiles),
      conflictFiles: stableArray(conflictFiles),
    };
  }

  private parseCommitLine(line: string): Commit {
    const [hash = '', shortHash = '', author = '', email = '', message = '', timestamp = '0'] = line.split('\x1f');
    return {
      hash,
      shortHash,
      author,
      email,
      message,
      timestamp: Number.parseInt(timestamp, 10) * 1000,
      filesChanged: [],
    };
  }

  getIndex(): FileIndex | null {
    return this.index;
  }

  getFile(pathValue: string): FileEntry | undefined {
    return this.index?.files.get(toPosixPath(pathValue));
  }

  getFilesByLanguage(language: string): FileEntry[] {
    if (!this.index) return [];
    return Array.from(this.index.files.values())
      .filter((entry) => entry.language === language.toLowerCase())
      .sort((a, b) => a.path.localeCompare(b.path));
  }

  searchFiles(pattern: string): FileEntry[] {
    if (!this.index) return [];
    const lowerPattern = pattern.toLowerCase();
    return Array.from(this.index.files.values()).filter((file) =>
      file.path.toLowerCase().includes(lowerPattern) || file.name.toLowerCase().includes(lowerPattern),
    );
  }

  getStats(): RepoStats {
    if (!this.index) {
      return {
        totalFiles: 0,
        totalDirectories: 0,
        totalSize: 0,
        totalLines: 0,
        languages: [],
        byExtension: new Map(),
      };
    }

    const byExtension = new Map<string, number>();
    for (const file of this.index.files.values()) {
      byExtension.set(file.extension, (byExtension.get(file.extension) || 0) + 1);
    }

    return {
      totalFiles: this.index.files.size,
      totalDirectories: this.index.directories.size,
      totalSize: Array.from(this.index.files.values()).reduce((sum, file) => sum + file.size, 0),
      totalLines: Array.from(this.index.languages.values()).reduce((sum, lang) => sum + lang.totalLines, 0),
      languages: Array.from(this.index.languages.values()).sort((a, b) => a.language.localeCompare(b.language)),
      byExtension,
    };
  }

  getGitInfoFromIndex(): GitInfo | undefined {
    return this.index?.gitInfo;
  }

  async getBlameInfo(filePath: string): Promise<GitBlameSummary | null> {
    const output = await this.runGit(['blame', '--line-porcelain', '--', filePath]);
    if (!output) return null;
    const authors = new Map<string, number>();
    let lineCount = 0;
    for (const line of output.split('\n')) {
      if (line.startsWith('author ')) {
        const author = line.slice(7);
        authors.set(author, (authors.get(author) || 0) + 1);
      }
      if (line.startsWith('\t')) lineCount++;
    }
    const sortedAuthors = Array.from(authors.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([author]) => author);
    return {
      path: filePath,
      authors: sortedAuthors,
      primaryAuthor: sortedAuthors[0],
      lineCount,
    };
  }

  async getFileHistory(filePath: string, limit = 10): Promise<FileHistorySummary> {
    const output = await this.runGit(['log', `-${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%ae%x1f%s%x1f%at', '--', filePath]);
    const commits = output ? output.split('\n').filter(Boolean).map((line) => this.parseCommitLine(line)) : [];
    return { path: filePath, commits };
  }

  async detectChangesSince(ref = 'HEAD'): Promise<FileChange[]> {
    const output = await this.runGit(['diff', '--name-status', ref]);
    if (!output) return [];
    return output
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [status, ...rest] = line.split(/\s+/);
        const pathValue = rest[rest.length - 1];
        const type = status.startsWith('A') ? 'added' : status.startsWith('D') ? 'deleted' : 'modified';
        return { path: pathValue, type } as FileChange;
      });
  }

  async compareBranches(base: string, target: string): Promise<GitComparisonSummary | null> {
    const [diff, counts] = await Promise.all([
      this.runGit(['diff', '--name-only', `${base}...${target}`]),
      this.runGit(['rev-list', '--left-right', '--count', `${base}...${target}`]),
    ]);
    if (diff == null || counts == null) return null;
    const [aheadRaw, behindRaw] = counts.split(/\s+/);
    return {
      base,
      target,
      changedFiles: diff ? stableArray(diff.split('\n').filter(Boolean)) : [],
      ahead: Number.parseInt(aheadRaw, 10) || 0,
      behind: Number.parseInt(behindRaw, 10) || 0,
    };
  }

  getRecentCommits(filePath?: string, limit = 10): Commit[] {
    if (!filePath) return [];
    return [];
  }

  async watch(callback: FileChangeCallback): Promise<void> {
    this.watchCallbacks.add(callback);
    this.isWatching = true;
  }

  stopWatching(): void {
    this.isWatching = false;
    this.watchCallbacks.clear();
  }

  async scanIncremental(changes: FileChange[]): Promise<FileIndex | null> {
    if (!this.index) return null;
    const nextFiles = new Map(this.index.files);
    const nextLanguages = new Map<string, LanguageStats>();
    const runtime: ScanRuntimeContext = {
      files: nextFiles,
      directories: new Map(this.index.directories),
      languages: nextLanguages,
      errors: [],
      dependencies: [],
      dependencyManifests: [],
      importGraph: new Map(((this.index as unknown as Record<string, unknown>).importGraph as Map<string, string[]>) || []),
      frameworks: new Set((((this.index as unknown as Record<string, unknown>).frameworks as string[]) || [])),
      circularDependencies: [],
      ignoredPatterns: [...this.ignorePatterns],
      processed: 0,
      changedFiles: [],
      deletedFiles: [],
      benchmark: this.lastBenchmark || {
        totalDurationMs: 0,
        traversalDurationMs: 0,
        fileProcessingDurationMs: 0,
        gitDurationMs: 0,
        dependencyDurationMs: 0,
        fileCount: this.index.files.size,
        cacheHits: 0,
        cacheMisses: 0,
      },
    };

    for (const change of changes) {
      if (change.type === 'deleted') {
        nextFiles.delete(change.path);
        runtime.importGraph.delete(change.path);
        this.fileCache.delete(change.path);
        continue;
      }
      const absPath = join(this.config.rootDir, change.path);
      await this.processFile(absPath, change.path, runtime, { force: true });
    }

    const liveImportGraph = new Map<string, string[]>();
    for (const [key, value] of runtime.importGraph.entries()) {
      if (nextFiles.has(key)) liveImportGraph.set(key, value);
    }
    runtime.importGraph = liveImportGraph;

    for (const file of nextFiles.values()) this.mergeLanguageStats(nextLanguages, file);
    this.finalizeDependencyGraph(runtime);
    this.index = {
      ...this.index,
      files: nextFiles,
      languages: nextLanguages,
      generatedAt: Date.now(),
      ...(runtime.importGraph ? { importGraph: runtime.importGraph } : {}),
      ...(runtime.circularDependencies ? { circularDependencies: runtime.circularDependencies } : {}),
      ...(runtime.dependencies ? { dependencies: runtime.dependencies } : {}),
      ...(runtime.frameworks ? { frameworks: stableArray(runtime.frameworks) } : {}),
    } as FileIndex;
    return this.index;
  }

  async refresh(): Promise<ScanResult> {
    return this.scan({ force: true });
  }

  getImportGraph(): Map<string, string[]> {
    return new Map((((this.index as unknown as Record<string, unknown>)?.importGraph as Map<string, string[]>) || []));
  }

  getCircularDependencies(): string[][] {
    return (((this.index as unknown as Record<string, unknown>)?.circularDependencies as string[][]) || []).map((cycle) => [...cycle]);
  }

  getDependencies(): DependencyInfo[] {
    return [ ...((((this.index as unknown as Record<string, unknown>)?.dependencies as DependencyInfo[]) || [])) ];
  }

  getFrameworks(): string[] {
    return [ ...((((this.index as unknown as Record<string, unknown>)?.frameworks as string[]) || [])) ];
  }

  getBenchmark(): RepoBenchmark | null {
    return this.lastBenchmark ? { ...this.lastBenchmark } : null;
  }
}

export class DependencyParser {
  async parse(filePath: string): Promise<DependencyInfo[]> {
    const name = basename(filePath).toLowerCase();
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (name === 'package.json') return this.parsePackageJson(content, filePath);
      if (name === 'cargo.toml') return this.parseCargoToml(content, filePath);
      if (name === 'requirements.txt') return this.parseRequirementsTxt(content, filePath);
      if (name === 'go.mod') return this.parseGoMod(content, filePath);
      if (name === 'gemfile') return this.parseGemfile(content, filePath);
      if (name === 'pyproject.toml') return this.parsePyProjectToml(content, filePath);
      return [];
    } catch {
      return [];
    }
  }

  parsePackageJson(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    try {
      const pkg = JSON.parse(content) as Record<string, Record<string, string> | undefined>;
      const addDeps = (obj: Record<string, string> | undefined, type: DependencyInfo['type']) => {
        if (!obj) return;
        for (const [name, version] of Object.entries(obj)) deps.push({ name, version, type, source });
      };
      addDeps(pkg.dependencies, 'production');
      addDeps(pkg.devDependencies, 'development');
      addDeps(pkg.peerDependencies, 'peer');
      addDeps(pkg.optionalDependencies, 'optional');
    } catch {
      // ignore
    }
    return deps;
  }

  parseCargoToml(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    let section = '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        section = trimmed.slice(1, -1);
        continue;
      }
      if (section === 'dependencies' || section === 'dev-dependencies') {
        const match = trimmed.match(/^([\w\-]+)\s*=\s*(?:\{[^}]*version\s*=\s*["']([^"']+)["'][^}]*\}|["']([^"']+)["'])/);
        if (match) {
          deps.push({
            name: match[1],
            version: match[2] || match[3] || '*',
            type: section === 'dev-dependencies' ? 'development' : 'production',
            source,
          });
        }
      }
    }
    return deps;
  }

  parseRequirementsTxt(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;
      const match = trimmed.match(/^([\w.\-\[\]]+)\s*([=<>~!]+\s*[^\s;]+)?/);
      if (match) {
        deps.push({
          name: match[1],
          version: (match[2] || '*').replace(/\s+/g, ''),
          type: 'production',
          source,
        });
      }
    }
    return deps;
  }

  parseGoMod(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    let inBlock = false;
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === 'require (') {
        inBlock = true;
        continue;
      }
      if (inBlock && trimmed === ')') {
        inBlock = false;
        continue;
      }
      const match = (inBlock ? trimmed : trimmed.replace(/^require\s+/, '')).match(/^(\S+)\s+(\S+)/);
      if ((inBlock || trimmed.startsWith('require ')) && match) {
        deps.push({ name: match[1], version: match[2], type: 'production', source });
      }
    }
    return deps;
  }

  parseGemfile(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/gem\s+["']([^"']+)["'](?:\s*,\s*["']([^"']+)["'])?/);
      if (match) deps.push({ name: match[1], version: match[2] || '*', type: 'production', source });
    }
    return deps;
  }

  parsePyProjectToml(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    let section = '';
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        section = trimmed.slice(1, -1);
        continue;
      }
      if ((section === 'project' || section === 'tool.poetry.dependencies' || section === 'tool.poetry.group.dev.dependencies') && trimmed.startsWith('dependencies')) {
        continue;
      }
      if (section === 'tool.poetry.dependencies' || section === 'tool.poetry.group.dev.dependencies') {
        const match = trimmed.match(/^([\w\-]+)\s*=\s*["']([^"']+)["']/);
        if (match) deps.push({ name: match[1], version: match[2], type: section.includes('.dev.') ? 'development' : 'production', source });
      }
      if (section === 'project' && trimmed.startsWith('dependencies = [')) {
        const inline = trimmed;
        for (const item of inline.matchAll(/["']([^"']+)["']/g)) {
          const depMatch = item[1].match(/^([\w\-]+)(.*)$/);
          if (depMatch) deps.push({ name: depMatch[1], version: depMatch[2]?.trim() || '*', type: 'production', source });
        }
      }
    }
    return deps;
  }
}

export function createRepoScanner(config: ScannerConfig): RepoScanner {
  return new RepoScanner(config);
}

export async function scanRepo(rootDir: string, options?: Partial<ScannerConfig>): Promise<ScanResult> {
  const scanner = new RepoScanner({ rootDir: resolve(rootDir), ...options });
  return scanner.scan();
}

export type {
  ScannerConfig,
  ScanOptions,
  FileIndex,
  FileEntry,
  DirectoryEntry,
  LanguageStats,
  GitInfo,
  GitFileStatus,
  Commit,
  RepoStats,
  FileStats,
  FileChange,
  FileChangeCallback,
  DependencyInfo,
  LanguageDetection,
  ScanResult,
  ScanError,
  IgnoreConfig,
};

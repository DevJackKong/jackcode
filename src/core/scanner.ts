/**
 * Thread 05: Repo Scanner
 * Repository traversal, indexing, language detection, dependency summaries,
 * git metadata extraction, and repository statistics.
 */

import { createHash } from 'crypto';
import { readFile, readdir, stat } from 'fs/promises';
import { basename, extname, join, relative, resolve } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface ScannerConfig {
  rootDir: string;
  include?: string[];
  exclude?: string[];
  ignorePatterns?: string[];
  respectGitignore?: boolean;
  followSymlinks?: boolean;
  maxDepth?: number;
  maxFileSizeBytes?: number;
  hashFiles?: boolean;
  includeGitMetadata?: boolean;
  commitLimit?: number;
}

export interface ScanOptions {
  paths?: string[];
  refreshGit?: boolean;
  includeStats?: boolean;
  includeDependencies?: boolean;
}

export interface FileStats {
  totalLines: number;
  codeLines: number;
  commentLines: number;
  blankLines: number;
}

export interface FileEntry {
  path: string;
  absolutePath: string;
  extension: string;
  language: string | null;
  size: number;
  modifiedAt: number;
  hash?: string;
  isBinary: boolean;
  stats?: FileStats;
  dependencyManifest?: boolean;
}

export interface DirectoryEntry {
  path: string;
  fileCount: number;
  directoryCount: number;
}

export interface LanguageSummary {
  language: string;
  fileCount: number;
  totalLines: number;
  extensions: string[];
}

export interface DependencyEntry {
  name: string;
  version: string;
  kind: 'production' | 'development' | 'peer' | 'optional' | 'unknown';
}

export interface DependencySummary {
  manifestPath: string;
  ecosystem: 'npm' | 'python' | 'rust' | 'go' | 'unknown';
  packages: DependencyEntry[];
}

export interface GitCommit {
  hash: string;
  shortHash: string;
  author: string;
  subject: string;
  timestamp: number;
}

export interface GitMetadata {
  rootDir: string;
  branch: string | null;
  head: string | null;
  recentCommits: GitCommit[];
  branches: string[];
  isDirty: boolean;
}

export interface RepoStats {
  totalFiles: number;
  totalDirectories: number;
  totalSize: number;
  totalLines: number;
  filesByExtension: Map<string, number>;
  filesByLanguage: Map<string, number>;
}

export interface FileIndex {
  rootDir: string;
  generatedAt: number;
  files: Map<string, FileEntry>;
  directories: Map<string, DirectoryEntry>;
  languages: Map<string, LanguageSummary>;
  dependencies: DependencySummary[];
  stats: RepoStats;
  git: GitMetadata | null;
  ignoredPatterns: string[];
}

export interface RepoScanResult {
  index: FileIndex;
  warnings: string[];
}

export interface IgnoreRuleSet {
  patterns: string[];
  sources: Array<'default' | '.gitignore' | 'custom'>;
}

const DEFAULT_EXCLUDES = ['.git', 'node_modules', 'dist', 'build', 'coverage'];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.php': 'php',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.md': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.html': 'html',
  '.sql': 'sql',
};

const SPECIAL_FILENAMES: Record<string, string> = {
  Dockerfile: 'dockerfile',
  Makefile: 'makefile',
};

export function detectLanguage(filePath: string, content?: string): string | null {
  const name = basename(filePath);
  if (SPECIAL_FILENAMES[name]) {
    return SPECIAL_FILENAMES[name];
  }

  const extension = extname(filePath).toLowerCase();
  if (extension && LANGUAGE_BY_EXTENSION[extension]) {
    return LANGUAGE_BY_EXTENSION[extension];
  }

  if (content) {
    const firstLine = content.split('\n', 1)[0] ?? '';
    return detectLanguageFromShebang(firstLine);
  }

  return null;
}

export function detectLanguageFromShebang(firstLine: string): string | null {
  if (!firstLine.startsWith('#!')) {
    return null;
  }

  if (firstLine.includes('python')) return 'python';
  if (firstLine.includes('node')) return 'javascript';
  if (firstLine.includes('bash') || firstLine.includes('sh') || firstLine.includes('zsh')) {
    return 'shell';
  }

  return null;
}

export function isDependencyManifest(filePath: string): boolean {
  const name = basename(filePath);
  return [
    'package.json',
    'requirements.txt',
    'Cargo.toml',
    'go.mod',
  ].includes(name);
}

export class RepoScanner {
  private config: Required<Omit<ScannerConfig, 'include' | 'exclude' | 'ignorePatterns'>> & {
    include: string[];
    exclude: string[];
    ignorePatterns: string[];
  };

  private index: FileIndex | null = null;

  constructor(config: ScannerConfig) {
    this.config = {
      rootDir: resolve(config.rootDir),
      include: config.include ?? [],
      exclude: config.exclude ?? DEFAULT_EXCLUDES,
      ignorePatterns: config.ignorePatterns ?? [],
      respectGitignore: config.respectGitignore ?? true,
      followSymlinks: config.followSymlinks ?? false,
      maxDepth: config.maxDepth ?? Number.POSITIVE_INFINITY,
      maxFileSizeBytes: config.maxFileSizeBytes ?? 1024 * 1024,
      hashFiles: config.hashFiles ?? false,
      includeGitMetadata: config.includeGitMetadata ?? true,
      commitLimit: config.commitLimit ?? 10,
    };
  }

  async scan(options: ScanOptions = {}): Promise<RepoScanResult> {
    const warnings: string[] = [];
    const files = new Map<string, FileEntry>();
    const directories = new Map<string, DirectoryEntry>();
    const languages = new Map<string, LanguageSummary>();
    const dependencies: DependencySummary[] = [];
    const ignoreRules = await this.loadIgnoreRules();

    await this.walk(this.config.rootDir, {
      depth: 0,
      files,
      directories,
      languages,
      dependencies,
      warnings,
      includeStats: options.includeStats ?? true,
      includeDependencies: options.includeDependencies ?? true,
      ignoreRules,
    });

    const stats = this.buildRepoStats(files, directories);
    const git = this.config.includeGitMetadata
      ? await this.safeGetGitMetadata(warnings)
      : null;

    const index: FileIndex = {
      rootDir: this.config.rootDir,
      generatedAt: Date.now(),
      files,
      directories,
      languages,
      dependencies,
      stats,
      git,
      ignoredPatterns: ignoreRules.patterns,
    };

    this.index = index;
    return { index, warnings };
  }

  async rescan(paths: string[]): Promise<RepoScanResult> {
    // Scaffold behavior: full scan fallback.
    // Future work can replace this with a targeted incremental refresh.
    void paths;
    return this.scan();
  }

  getIndex(): FileIndex | null {
    return this.index;
  }

  getFile(path: string): FileEntry | undefined {
    return this.index?.files.get(path);
  }

  getFilesByLanguage(language: string): FileEntry[] {
    if (!this.index) return [];
    return Array.from(this.index.files.values()).filter((file) => file.language === language);
  }

  getDependencySummaries(): DependencySummary[] {
    return this.index?.dependencies ?? [];
  }

  getStats(): RepoStats | null {
    return this.index?.stats ?? null;
  }

  async getGitMetadata(): Promise<GitMetadata | null> {
    const warnings: string[] = [];
    return this.safeGetGitMetadata(warnings);
  }

  private async walk(
    currentDir: string,
    context: {
      depth: number;
      files: Map<string, FileEntry>;
      directories: Map<string, DirectoryEntry>;
      languages: Map<string, LanguageSummary>;
      dependencies: DependencySummary[];
      warnings: string[];
      includeStats: boolean;
      includeDependencies: boolean;
      ignoreRules: IgnoreRuleSet;
    }
  ): Promise<void> {
    if (context.depth > this.config.maxDepth) {
      return;
    }

    const relativeDir = this.toRelativePath(currentDir);
    if (relativeDir && this.shouldIgnore(relativeDir, true, context.ignoreRules)) {
      return;
    }

    const entries = await readdir(currentDir, { withFileTypes: true });
    let fileCount = 0;
    let directoryCount = 0;

    for (const entry of entries) {
      const absolutePath = join(currentDir, entry.name);
      const relativePath = this.toRelativePath(absolutePath);

      if (this.shouldIgnore(relativePath, entry.isDirectory(), context.ignoreRules)) {
        continue;
      }

      if (entry.isDirectory()) {
        directoryCount += 1;
        await this.walk(absolutePath, {
          ...context,
          depth: context.depth + 1,
        });
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      fileCount += 1;
      const fileEntry = await this.indexFile(absolutePath, relativePath, {
        includeStats: context.includeStats,
      });

      context.files.set(relativePath, fileEntry);
      this.updateLanguageSummary(context.languages, fileEntry);

      if (context.includeDependencies && fileEntry.dependencyManifest) {
        const dependencySummary = await this.parseDependencyManifest(absolutePath, relativePath);
        if (dependencySummary) {
          context.dependencies.push(dependencySummary);
        }
      }
    }

    context.directories.set(relativeDir || '.', {
      path: relativeDir || '.',
      fileCount,
      directoryCount,
    });
  }

  private async indexFile(
    absolutePath: string,
    relativePath: string,
    options: { includeStats: boolean }
  ): Promise<FileEntry> {
    const fileStat = await stat(absolutePath);
    const extension = extname(relativePath).toLowerCase();
    const size = fileStat.size;
    const shouldReadContent = size <= this.config.maxFileSizeBytes;
    const buffer = shouldReadContent ? await readFile(absolutePath) : null;
    const content = buffer ? buffer.toString('utf8') : undefined;
    const language = detectLanguage(relativePath, content);
    const isBinary = buffer ? buffer.includes(0) : false;
    const stats = !isBinary && options.includeStats && content
      ? this.computeFileStats(content, language)
      : undefined;

    return {
      path: relativePath,
      absolutePath,
      extension,
      language,
      size,
      modifiedAt: fileStat.mtimeMs,
      hash: this.config.hashFiles && buffer ? createHash('sha1').update(buffer).digest('hex') : undefined,
      isBinary,
      stats,
      dependencyManifest: isDependencyManifest(relativePath),
    };
  }

  private computeFileStats(content: string, language: string | null): FileStats {
    const lines = content.split(/\r?\n/);
    let blankLines = 0;
    let commentLines = 0;
    let codeLines = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) {
        blankLines += 1;
        continue;
      }

      if (this.isCommentLine(trimmed, language)) {
        commentLines += 1;
        continue;
      }

      codeLines += 1;
    }

    return {
      totalLines: lines.length,
      codeLines,
      commentLines,
      blankLines,
    };
  }

  private isCommentLine(line: string, language: string | null): boolean {
    if (line.startsWith('//') || line.startsWith('#') || line.startsWith('/*') || line.startsWith('*')) {
      return true;
    }

    if (language === 'html' && line.startsWith('<!--')) {
      return true;
    }

    return false;
  }

  private updateLanguageSummary(
    languages: Map<string, LanguageSummary>,
    file: FileEntry
  ): void {
    const language = file.language ?? 'unknown';
    const existing = languages.get(language);
    const totalLines = file.stats?.totalLines ?? 0;
    const extension = file.extension || '<none>';

    if (existing) {
      existing.fileCount += 1;
      existing.totalLines += totalLines;
      if (!existing.extensions.includes(extension)) {
        existing.extensions.push(extension);
      }
      return;
    }

    languages.set(language, {
      language,
      fileCount: 1,
      totalLines,
      extensions: [extension],
    });
  }

  private buildRepoStats(
    files: Map<string, FileEntry>,
    directories: Map<string, DirectoryEntry>
  ): RepoStats {
    const filesByExtension = new Map<string, number>();
    const filesByLanguage = new Map<string, number>();
    let totalSize = 0;
    let totalLines = 0;

    for (const file of files.values()) {
      totalSize += file.size;
      totalLines += file.stats?.totalLines ?? 0;

      const extension = file.extension || '<none>';
      filesByExtension.set(extension, (filesByExtension.get(extension) ?? 0) + 1);

      const language = file.language ?? 'unknown';
      filesByLanguage.set(language, (filesByLanguage.get(language) ?? 0) + 1);
    }

    return {
      totalFiles: files.size,
      totalDirectories: directories.size,
      totalSize,
      totalLines,
      filesByExtension,
      filesByLanguage,
    };
  }

  private async loadIgnoreRules(): Promise<IgnoreRuleSet> {
    const patterns = [...DEFAULT_EXCLUDES, ...this.config.exclude, ...this.config.ignorePatterns];
    const sources: Array<'default' | '.gitignore' | 'custom'> = [
      ...DEFAULT_EXCLUDES.map(() => 'default' as const),
      ...this.config.exclude.map(() => 'custom' as const),
      ...this.config.ignorePatterns.map(() => 'custom' as const),
    ];

    if (this.config.respectGitignore) {
      try {
        const gitignorePath = join(this.config.rootDir, '.gitignore');
        const gitignore = await readFile(gitignorePath, 'utf8');
        for (const rawLine of gitignore.split(/\r?\n/)) {
          const line = rawLine.trim();
          if (!line || line.startsWith('#')) {
            continue;
          }
          patterns.push(line);
          sources.push('.gitignore');
        }
      } catch {
        // Optional file. Ignore read errors in scaffold implementation.
      }
    }

    return { patterns, sources };
  }

  private shouldIgnore(path: string, isDirectory: boolean, rules: IgnoreRuleSet): boolean {
    const normalized = path.replaceAll('\\', '/');
    for (const pattern of rules.patterns) {
      const candidate = pattern.replace(/\/$/, '');
      if (!candidate) continue;

      if (normalized === candidate || normalized.startsWith(`${candidate}/`)) {
        return true;
      }

      if (isDirectory && basename(normalized) === candidate) {
        return true;
      }
    }
    return false;
  }

  private async parseDependencyManifest(
    absolutePath: string,
    relativePath: string
  ): Promise<DependencySummary | null> {
    const name = basename(relativePath);
    const content = await readFile(absolutePath, 'utf8');

    switch (name) {
      case 'package.json':
        return this.parsePackageJson(relativePath, content);
      case 'requirements.txt':
        return this.parseRequirementsTxt(relativePath, content);
      case 'Cargo.toml':
        return this.parseCargoToml(relativePath, content);
      case 'go.mod':
        return this.parseGoMod(relativePath, content);
      default:
        return null;
    }
  }

  private parsePackageJson(manifestPath: string, content: string): DependencySummary | null {
    const parsed = JSON.parse(content) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      optionalDependencies?: Record<string, string>;
    };

    const packages: DependencyEntry[] = [];
    const pushEntries = (deps: Record<string, string> | undefined, kind: DependencyEntry['kind']) => {
      if (!deps) return;
      for (const [name, version] of Object.entries(deps)) {
        packages.push({ name, version, kind });
      }
    };

    pushEntries(parsed.dependencies, 'production');
    pushEntries(parsed.devDependencies, 'development');
    pushEntries(parsed.peerDependencies, 'peer');
    pushEntries(parsed.optionalDependencies, 'optional');

    return {
      manifestPath,
      ecosystem: 'npm',
      packages,
    };
  }

  private parseRequirementsTxt(manifestPath: string, content: string): DependencySummary {
    const packages: DependencyEntry[] = content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => {
        const [name, version = ''] = line.split(/==|>=|<=|~=|!=/);
        return {
          name: name.trim(),
          version: version.trim(),
          kind: 'production' as const,
        };
      });

    return {
      manifestPath,
      ecosystem: 'python',
      packages,
    };
  }

  private parseCargoToml(manifestPath: string, content: string): DependencySummary {
    const packages: DependencyEntry[] = [];
    let inDependencies = false;
    let inDevDependencies = false;

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      if (line === '[dependencies]') {
        inDependencies = true;
        inDevDependencies = false;
        continue;
      }
      if (line === '[dev-dependencies]') {
        inDependencies = false;
        inDevDependencies = true;
        continue;
      }
      if (line.startsWith('[')) {
        inDependencies = false;
        inDevDependencies = false;
        continue;
      }
      if (!inDependencies && !inDevDependencies) continue;

      const [name, version = ''] = line.split('=');
      packages.push({
        name: name.trim(),
        version: version.trim().replaceAll('"', ''),
        kind: inDevDependencies ? 'development' : 'production',
      });
    }

    return {
      manifestPath,
      ecosystem: 'rust',
      packages,
    };
  }

  private parseGoMod(manifestPath: string, content: string): DependencySummary {
    const packages: DependencyEntry[] = [];
    let inRequireBlock = false;

    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//')) continue;
      if (line === 'require (') {
        inRequireBlock = true;
        continue;
      }
      if (inRequireBlock && line === ')') {
        inRequireBlock = false;
        continue;
      }
      if (line.startsWith('require ')) {
        const [, name, version = ''] = line.split(/\s+/);
        packages.push({ name, version, kind: 'production' });
        continue;
      }
      if (inRequireBlock) {
        const [name, version = ''] = line.split(/\s+/);
        packages.push({ name, version, kind: 'production' });
      }
    }

    return {
      manifestPath,
      ecosystem: 'go',
      packages,
    };
  }

  private async safeGetGitMetadata(warnings: string[]): Promise<GitMetadata | null> {
    try {
      return await this.readGitMetadata();
    } catch (error) {
      warnings.push(
        `Git metadata unavailable: ${error instanceof Error ? error.message : String(error)}`
      );
      return null;
    }
  }

  private async readGitMetadata(): Promise<GitMetadata | null> {
    const rootDir = this.config.rootDir;
    const branch = await this.git(['branch', '--show-current']);
    const head = await this.git(['rev-parse', 'HEAD']);
    const branchesOutput = await this.git(['branch', '--format=%(refname:short)']);
    const statusOutput = await this.git(['status', '--porcelain']);
    const recentOutput = await this.git([
      'log',
      `--max-count=${this.config.commitLimit}`,
      '--pretty=format:%H%x09%h%x09%an%x09%s%x09%ct',
    ]);

    const recentCommits: GitCommit[] = recentOutput
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [hash, shortHash, author, subject, timestamp] = line.split('\t');
        return {
          hash,
          shortHash,
          author,
          subject,
          timestamp: Number(timestamp) * 1000,
        };
      });

    return {
      rootDir,
      branch: branch || null,
      head: head || null,
      recentCommits,
      branches: branchesOutput.split(/\r?\n/).filter(Boolean),
      isDirty: statusOutput.trim().length > 0,
    };
  }

  private async git(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: this.config.rootDir,
    });
    return stdout.trim();
  }

  private toRelativePath(absolutePath: string): string {
    return relative(this.config.rootDir, absolutePath).replaceAll('\\', '/');
  }
}

export function createRepoScanner(config: ScannerConfig): RepoScanner {
  return new RepoScanner(config);
}

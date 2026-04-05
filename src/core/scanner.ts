/**
 * Thread 05: Repo Scanner
 * Repository scanning and analysis module
 * 
 * Provides file system traversal, language detection, dependency analysis,
 * and Git metadata extraction for comprehensive codebase understanding.
 */

import { createHash } from 'crypto';
import { promises as fs, constants } from 'fs';
import { join, relative, extname, basename, dirname, sep, posix } from 'path';
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

// Default configuration values
const DEFAULT_CONFIG: Partial<ScannerConfig> = {
  include: ['**/*'],
  exclude: [],
  respectGitignore: true,
  maxFileSize: 10 * 1024 * 1024, // 10MB
  followSymlinks: false,
  maxDepth: 50,
};

// Language mapping by extension
const EXTENSION_TO_LANGUAGE: Map<string, string> = new Map([
  ['ts', 'typescript'], ['tsx', 'typescript'],
  ['js', 'javascript'], ['jsx', 'javascript'], ['mjs', 'javascript'], ['cjs', 'javascript'],
  ['py', 'python'],
  ['rb', 'ruby'],
  ['go', 'go'],
  ['rs', 'rust'],
  ['java', 'java'],
  ['kt', 'kotlin'],
  ['swift', 'swift'],
  ['cpp', 'cpp'], ['cc', 'cpp'], ['cxx', 'cpp'], ['hpp', 'cpp'], ['h', 'c'],
  ['c', 'c'],
  ['cs', 'csharp'],
  ['php', 'php'],
  ['sh', 'shell'], ['bash', 'shell'], ['zsh', 'shell'],
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
  ['clj', 'clojure'], ['cljs', 'clojure'],
  ['coffee', 'coffeescript'],
  ['purs', 'purescript'],
  ['re', 'reason'], ['rei', 'reason'],
  ['v', 'v'],
  ['zig', 'zig'],
  ['md', 'markdown'], ['mdx', 'markdown'],
  ['json', 'json'], ['jsonc', 'json'],
  ['yaml', 'yaml'], ['yml', 'yaml'],
  ['toml', 'toml'],
  ['xml', 'xml'],
  ['sql', 'sql'],
  ['html', 'html'], ['htm', 'html'],
  ['css', 'css'], ['scss', 'scss'], ['sass', 'sass'], ['less', 'less'],
  ['vue', 'vue'],
  ['svelte', 'svelte'],
  ['astro', 'astro'],
  ['sol', 'solidity'],
  ['vy', 'vyper'],
]);

// Language to extensions mapping (computed from above)
const LANGUAGE_TO_EXTENSIONS: Map<string, string[]> = new Map();
for (const [ext, lang] of EXTENSION_TO_LANGUAGE) {
  const exts = LANGUAGE_TO_EXTENSIONS.get(lang) || [];
  exts.push(ext);
  LANGUAGE_TO_EXTENSIONS.set(lang, exts);
}

/**
 * Language detection utility class
 */
export class LanguageDetector {
  /**
   * Detect language from file path and optional content
   */
  detect(filePath: string, content?: string): LanguageDetection {
    const ext = extname(filePath).toLowerCase().slice(1);
    
    // Try extension-based detection first
    if (ext) {
      const lang = EXTENSION_TO_LANGUAGE.get(ext);
      if (lang) {
        return { language: lang, confidence: 0.9, method: 'extension' };
      }
    }
    
    // Try content-based detection if content provided
    if (content) {
      const contentLang = this.detectByContent(content);
      if (contentLang) {
        return { language: contentLang, confidence: 0.8, method: 'content' };
      }
      
      // Try shebang detection
      const shebangLang = this.detectByShebang(content);
      if (shebangLang) {
        return { language: shebangLang, confidence: 0.85, method: 'shebang' };
      }
    }
    
    return { language: null, confidence: 0, method: 'none' };
  }
  
  /**
   * Detect language by file extension only
   */
  detectByExtension(extension: string): string | null {
    const ext = extension.toLowerCase().replace(/^\./, '');
    return EXTENSION_TO_LANGUAGE.get(ext) || null;
  }
  
  /**
   * Detect language by content analysis
   */
  detectByContent(content: string): string | null {
    // Simple heuristics for common patterns
    if (content.includes('<?php')) return 'php';
    if (content.includes('#!/usr/bin/env python') || content.includes('#!/usr/bin/python')) return 'python';
    if (content.includes('#!/usr/bin/env ruby') || content.includes('#!/usr/bin/ruby')) return 'ruby';
    if (content.includes('#!/bin/bash') || content.includes('#!/bin/sh')) return 'shell';
    if (content.includes('<?xml')) return 'xml';
    if (content.trimStart().startsWith('{') || content.trimStart().startsWith('[')) {
      try {
        JSON.parse(content);
        return 'json';
      } catch {
        // Not valid JSON
      }
    }
    return null;
  }
  
  /**
   * Detect language from shebang line
   */
  private detectByShebang(content: string): string | null {
    const firstLine = content.split('\n')[0].trim();
    if (!firstLine.startsWith('#!')) return null;
    
    const shebang = firstLine.toLowerCase();
    if (shebang.includes('python')) return 'python';
    if (shebang.includes('node')) return 'javascript';
    if (shebang.includes('ruby')) return 'ruby';
    if (shebang.includes('bash') || shebang.includes('sh')) return 'shell';
    if (shebang.includes('perl')) return 'perl';
    if (shebang.includes('lua')) return 'lua';
    return null;
  }
  
  /**
   * Get all extensions for a language
   */
  getExtensions(language: string): string[] {
    return LANGUAGE_TO_EXTENSIONS.get(language.toLowerCase()) || [];
  }
  
  /**
   * Check if file is a text file (not binary)
   */
  isTextFile(filePath: string, sample?: Buffer): boolean {
    const binaryExtensions = [
      'exe', 'dll', 'so', 'dylib', 'bin',
      'jpg', 'jpeg', 'png', 'gif', 'bmp', 'svg', 'ico', 'webp',
      'mp3', 'mp4', 'wav', 'ogg', 'webm',
      'zip', 'tar', 'gz', 'bz2', '7z', 'rar',
      'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
      'db', 'sqlite', 'sqlite3',
      'woff', 'woff2', 'ttf', 'otf', 'eot',
      'wasm', 'class', 'o', 'a', 'lib',
    ];
    
    const ext = extname(filePath).toLowerCase().slice(1);
    if (binaryExtensions.includes(ext)) return false;
    
    // Check for null bytes in sample
    if (sample) {
      for (let i = 0; i < Math.min(sample.length, 8000); i++) {
        if (sample[i] === 0) return false;
      }
    }
    
    return true;
  }
}

/**
 * Calculate file statistics (lines, comments, etc.)
 */
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
    
    // Simple comment detection for common languages
    const lang = language || '';
    const isCStyle = ['typescript', 'javascript', 'java', 'c', 'cpp', 'csharp', 'go', 'rust', 'swift', 'kotlin'].includes(lang);
    const isScript = ['python', 'shell', 'ruby', 'perl', 'yaml'].includes(lang);
    
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
    } else if (isScript) {
      if (trimmed.startsWith('#')) {
        commentLines++;
      } else {
        codeLines++;
      }
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

/**
 * Parse .gitignore patterns
 */
async function parseGitignore(dirPath: string): Promise<string[]> {
  const gitignorePath = join(dirPath, '.gitignore');
  try {
    const content = await fs.readFile(gitignorePath, 'utf-8');
    return content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
  } catch {
    return [];
  }
}

/**
 * Check if a path matches any pattern in the ignore list
 */
function matchesIgnorePatterns(filePath: string, patterns: string[], rootDir: string): boolean {
  // Simple pattern matching - can be enhanced with minimatch library
  for (const pattern of patterns) {
    // Convert gitignore-style patterns to simple checks
    const normalizedPattern = pattern.replace(/\*/g, '.*').replace(/\?/g, '.');
    const regex = new RegExp(normalizedPattern);
    if (regex.test(filePath)) return true;
    if (filePath.includes(pattern)) return true;
  }
  return false;
}

/**
 * Main RepoScanner class
 */
export class RepoScanner {
  private config: Required<ScannerConfig>;
  private index: FileIndex | null = null;
  private languageDetector: LanguageDetector;
  private ignorePatterns: string[] = [];
  private watchCallbacks: Set<FileChangeCallback> = new Set();
  private isWatching = false;

  constructor(config: ScannerConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<ScannerConfig>;
    this.languageDetector = new LanguageDetector();
  }

  /**
   * Perform full repository scan
   */
  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const startTime = Date.now();
    const errors: ScanError[] = [];

    try {
      // Load ignore patterns if respecting gitignore
      if (this.config.respectGitignore) {
        this.ignorePatterns = await parseGitignore(this.config.rootDir);
      }
      this.ignorePatterns = [...this.ignorePatterns, ...this.config.exclude];

      // Initialize index
      const files = new Map<string, FileEntry>();
      const directories = new Map<string, DirectoryEntry>();
      const languages = new Map<string, LanguageStats>();

      // Scan directories recursively
      await this.scanDirectory(
        this.config.rootDir,
        '',
        files,
        directories,
        languages,
        errors,
        options,
        0
      );

      // Try to get Git info
      const gitInfo = await this.getGitInfo();

      this.index = {
        rootDir: this.config.rootDir,
        files,
        directories,
        languages,
        generatedAt: Date.now(),
        gitInfo,
      };

      return {
        success: true,
        index: this.index,
        filesProcessed: files.size,
        durationMs: Date.now() - startTime,
        errors,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
        filesProcessed: 0,
        durationMs: Date.now() - startTime,
        errors,
      };
    }
  }

  /**
   * Scan a directory recursively
   */
  private async scanDirectory(
    absolutePath: string,
    relativePath: string,
    files: Map<string, FileEntry>,
    directories: Map<string, DirectoryEntry>,
    languages: Map<string, LanguageStats>,
    errors: ScanError[],
    options: ScanOptions,
    depth: number
  ): Promise<void> {
    if (depth > (this.config.maxDepth || 50)) return;

    // Check if directory should be ignored
    if (matchesIgnorePatterns(relativePath, this.ignorePatterns, this.config.rootDir)) {
      return;
    }

    try {
      const entries = await fs.readdir(absolutePath, { withFileTypes: true });
      const filePaths: string[] = [];
      const subdirs: string[] = [];

      for (const entry of entries) {
        const entryName = entry.name;
        const entryRelPath = relativePath ? `${relativePath}/${entryName}` : entryName;
        const entryAbsPath = join(absolutePath, entryName);

        // Skip hidden files and common non-source directories
        if (entryName.startsWith('.') && entryName !== '.github' && entryName !== '.vscode') {
          continue;
        }

        if (matchesIgnorePatterns(entryRelPath, this.ignorePatterns, this.config.rootDir)) {
          continue;
        }

        if (entry.isDirectory()) {
          if (this.config.followSymlinks || !entry.isSymbolicLink()) {
            subdirs.push(entryRelPath);
            await this.scanDirectory(
              entryAbsPath,
              entryRelPath,
              files,
              directories,
              languages,
              errors,
              options,
              depth + 1
            );
          }
        } else if (entry.isFile()) {
          if (!this.config.followSymlinks && entry.isSymbolicLink()) {
            continue;
          }
          filePaths.push(entryRelPath);
          await this.processFile(
            entryAbsPath,
            entryRelPath,
            files,
            languages,
            errors,
            options
          );
        }
      }

      // Calculate directory size
      let dirSize = 0;
      for (const filePath of filePaths) {
        const file = files.get(filePath);
        if (file) dirSize += file.size;
      }

      // Store directory entry
      const stats = await fs.stat(absolutePath);
      directories.set(relativePath, {
        path: relativePath,
        absolutePath,
        files: filePaths,
        subdirectories: subdirs,
        size: dirSize,
        modifiedAt: stats.mtimeMs,
      });
    } catch (error) {
      errors.push({
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process a single file
   */
  private async processFile(
    absolutePath: string,
    relativePath: string,
    files: Map<string, FileEntry>,
    languages: Map<string, LanguageStats>,
    errors: ScanError[],
    options: ScanOptions
  ): Promise<void> {
    try {
      const stats = await fs.stat(absolutePath);
      
      // Skip files larger than max size
      if (this.config.maxFileSize && stats.size > this.config.maxFileSize) {
        return;
      }

      // Read file content for analysis
      const content = await fs.readFile(absolutePath, 'utf-8');
      const contentHash = createHash('sha256').update(content).digest('hex');

      // Detect language
      const detection = this.languageDetector.detect(absolutePath, content);
      const language = detection.language;

      // Calculate file stats
      const fileStats = calculateFileStats(content, language);

      const fileEntry: FileEntry = {
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
      };

      files.set(relativePath, fileEntry);

      // Update language stats
      if (language) {
        const langStats = languages.get(language) || {
          language,
          fileCount: 0,
          totalLines: 0,
          codeLines: 0,
          commentLines: 0,
          blankLines: 0,
          extensions: this.languageDetector.getExtensions(language),
          totalSize: 0,
        };
        langStats.fileCount++;
        langStats.totalLines += fileStats.totalLines;
        langStats.codeLines += fileStats.codeLines;
        langStats.commentLines += fileStats.commentLines;
        langStats.blankLines += fileStats.blankLines;
        langStats.totalSize += stats.size;
        languages.set(language, langStats);
      }
    } catch (error) {
      errors.push({
        path: relativePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Get Git repository information
   */
  private async getGitInfo(): Promise<GitInfo | undefined> {
    try {
      // Check for .git directory
      const gitPath = join(this.config.rootDir, '.git');
      await fs.access(gitPath, constants.R_OK);

      // TODO: Integrate with simple-git for full Git operations
      // For now, return basic info
      return {
        isRepo: true,
        rootPath: this.config.rootDir,
        currentBranch: 'main', // Placeholder
        untrackedFiles: [],
        modifiedFiles: [],
        stagedFiles: [],
        conflictFiles: [],
      };
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
  }

  /**
   * Get current file index
   */
  getIndex(): FileIndex | null {
    return this.index;
  }

  /**
   * Get a file entry by path
   */
  getFile(path: string): FileEntry | undefined {
    if (!this.index) return undefined;
    return this.index.files.get(path);
  }

  /**
   * Get all files for a specific language
   */
  getFilesByLanguage(language: string): FileEntry[] {
    if (!this.index) return [];
    return Array.from(this.index.files.values()).filter(
      (f) => f.language === language.toLowerCase()
    );
  }

  /**
   * Search files by pattern (simple substring match)
   */
  searchFiles(pattern: string): FileEntry[] {
    if (!this.index) return [];
    const lowerPattern = pattern.toLowerCase();
    return Array.from(this.index.files.values()).filter(
      (f) =>
        f.path.toLowerCase().includes(lowerPattern) ||
        f.name.toLowerCase().includes(lowerPattern)
    );
  }

  /**
   * Get repository statistics
   */
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
      const count = byExtension.get(file.extension) || 0;
      byExtension.set(file.extension, count + 1);
    }

    return {
      totalFiles: this.index.files.size,
      totalDirectories: this.index.directories.size,
      totalSize: Array.from(this.index.files.values()).reduce((sum, f) => sum + f.size, 0),
      totalLines: Array.from(this.index.languages.values()).reduce(
        (sum, l) => sum + l.totalLines,
        0
      ),
      languages: Array.from(this.index.languages.values()),
      byExtension,
    };
  }

  /**
   * Get Git info (requires prior scan)
   */
  getGitInfoFromIndex(): GitInfo | undefined {
    return this.index?.gitInfo;
  }

  /**
   * Get recent commits for a file or all files
   * TODO: Integrate with simple-git for full implementation
   */
  getRecentCommits(filePath?: string, limit = 10): Commit[] {
    // Placeholder - implement with simple-git
    return [];
  }

  /**
   * Start watching for file changes
   * TODO: Implement with fs.watch or chokidar
   */
  async watch(callback: FileChangeCallback): Promise<void> {
    this.watchCallbacks.add(callback);
    this.isWatching = true;
    // TODO: Implement actual file watching
  }

  /**
   * Stop watching for file changes
   */
  stopWatching(): void {
    this.isWatching = false;
    this.watchCallbacks.clear();
  }

  /**
   * Perform incremental scan for changed files
   */
  async scanIncremental(changes: FileChange[]): Promise<FileIndex | null> {
    if (!this.index) return null;

    for (const change of changes) {
      const absPath = join(this.config.rootDir, change.path);

      if (change.type === 'deleted') {
        this.index.files.delete(change.path);
      } else {
        // Re-scan the file
        const errors: ScanError[] = [];
        await this.processFile(
          absPath,
          change.path,
          this.index.files,
          this.index.languages,
          errors,
          {}
        );
      }
    }

    this.index.generatedAt = Date.now();
    return this.index;
  }

  /**
   * Force refresh the index
   */
  async refresh(): Promise<ScanResult> {
    return this.scan({ force: true });
  }
}

/**
 * Dependency parser for various package managers
 */
export class DependencyParser {
  /**
   * Parse dependency file and extract dependencies
   */
  async parse(filePath: string): Promise<DependencyInfo[]> {
    const ext = extname(filePath).toLowerCase();
    const name = basename(filePath).toLowerCase();

    try {
      const content = await fs.readFile(filePath, 'utf-8');

      if (name === 'package.json') {
        return this.parsePackageJson(content, filePath);
      }
      if (name === 'cargo.toml') {
        return this.parseCargoToml(content, filePath);
      }
      if (name === 'requirements.txt') {
        return this.parseRequirementsTxt(content, filePath);
      }
      if (name === 'go.mod') {
        return this.parseGoMod(content, filePath);
      }
      if (name === 'gemfile') {
        return this.parseGemfile(content, filePath);
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Parse package.json dependencies
   */
  parsePackageJson(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    try {
      const pkg = JSON.parse(content);

      const addDeps = (obj: Record<string, string> | undefined, type: DependencyInfo['type']) => {
        if (!obj) return;
        for (const [name, version] of Object.entries(obj)) {
          deps.push({ name, version, type, source });
        }
      };

      addDeps(pkg.dependencies, 'production');
      addDeps(pkg.devDependencies, 'development');
      addDeps(pkg.peerDependencies, 'peer');
      addDeps(pkg.optionalDependencies, 'optional');
    } catch {
      // Invalid JSON
    }
    return deps;
  }

  /**
   * Parse Cargo.toml dependencies
   */
  parseCargoToml(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    // Simple line-based parsing for now
    const lines = content.split('\n');
    let inDepsSection = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed === '[dependencies]') {
        inDepsSection = true;
        continue;
      }
      if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
        inDepsSection = false;
        continue;
      }
      if (inDepsSection && trimmed) {
        const match = trimmed.match(/^([\w\-]+)\s*=\s*["']([^"']+)["']/);
        if (match) {
          deps.push({
            name: match[1],
            version: match[2],
            type: 'production',
            source,
          });
        }
      }
    }

    return deps;
  }

  /**
   * Parse requirements.txt dependencies
   */
  parseRequirementsTxt(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('-')) continue;

      // Parse package==version, package>=version, package~=version, etc.
      const match = trimmed.match(/^([\w\-]+)\s*[=<>~!]+\s*([^\s;]+)/);
      if (match) {
        deps.push({
          name: match[1],
          version: match[2],
          type: 'production',
          source,
        });
      } else {
        // Package without version specifier
        const simpleMatch = trimmed.match(/^(\w[\w\-]*)/);
        if (simpleMatch) {
          deps.push({
            name: simpleMatch[1],
            version: '*',
            type: 'production',
            source,
          });
        }
      }
    }

    return deps;
  }

  /**
   * Parse go.mod dependencies
   */
  parseGoMod(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    const lines = content.split('\n');
    let inRequire = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('require (')) {
        inRequire = true;
        continue;
      }
      if (inRequire && trimmed === ')') {
        inRequire = false;
        continue;
      }
      if (inRequire || trimmed.startsWith('require ')) {
        const match = trimmed.match(/require\s+(\S+)\s+(\S+)/);
        if (match) {
          deps.push({
            name: match[1],
            version: match[2],
            type: 'production',
            source,
          });
        }
      }
    }

    return deps;
  }

  /**
   * Parse Gemfile dependencies
   */
  parseGemfile(content: string, source: string): DependencyInfo[] {
    const deps: DependencyInfo[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      // Match gem "name", "version" or gem 'name', 'version'
      const match = trimmed.match(/gem\s+["']([^"']+)["']\s*(?:,\s*["']([^"']+)["'])?/);
      if (match) {
        deps.push({
          name: match[1],
          version: match[2] || '*',
          type: 'production',
          source,
        });
      }
    }

    return deps;
  }
}

/**
 * Create a new RepoScanner instance
 */
export function createRepoScanner(config: ScannerConfig): RepoScanner {
  return new RepoScanner(config);
}

/**
 * Quick scan utility function
 */
export async function scanRepo(
  rootDir: string,
  options?: Partial<ScannerConfig>
): Promise<ScanResult> {
  const scanner = new RepoScanner({
    rootDir,
    ...options,
  });
  return scanner.scan();
}

// Re-export types
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

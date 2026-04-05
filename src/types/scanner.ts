// Thread 05: Repo Scanner Types
// Repository scanning and analysis type definitions

/** Scanner configuration options */
export interface ScannerConfig {
  /** Root directory to scan */
  rootDir: string;
  /** Include patterns (glob) - if empty, include all */
  include?: string[];
  /** Exclude patterns (glob) - applied after include */
  exclude?: string[];
  /** Whether to respect .gitignore files */
  respectGitignore?: boolean;
  /** Skip files larger than this size (bytes) */
  maxFileSize?: number;
  /** Follow symbolic links */
  followSymlinks?: boolean;
  /** Maximum directory depth to traverse */
  maxDepth?: number;
}

/** Options for scan operations */
export interface ScanOptions {
  /** Force full re-scan even if cached */
  force?: boolean;
  /** Specific paths to scan (relative to root) */
  paths?: string[];
  /** Include binary files in index */
  includeBinary?: boolean;
  /** Progress callback */
  onProgress?: (processed: number, total: number, currentPath: string) => void;
}

/** Complete file index for a repository */
export interface FileIndex {
  /** Root directory path */
  rootDir: string;
  /** Indexed files by relative path */
  files: Map<string, FileEntry>;
  /** Indexed directories by relative path */
  directories: Map<string, DirectoryEntry>;
  /** Language statistics by language identifier */
  languages: Map<string, LanguageStats>;
  /** Timestamp when index was generated */
  generatedAt: number;
  /** Git repository information */
  gitInfo?: GitInfo;
}

/** File entry in the index */
export interface FileEntry {
  /** Relative path from root */
  path: string;
  /** Absolute file path */
  absolutePath: string;
  /** File name with extension */
  name: string;
  /** File extension (lowercase, without dot) */
  extension: string;
  /** Detected programming language */
  language: string | null;
  /** File size in bytes */
  size: number;
  /** Last modification timestamp */
  modifiedAt: number;
  /** File creation timestamp */
  createdAt: number;
  /** SHA-256 hash of file content */
  contentHash: string;
  /** Total line count */
  lines: number;
  /** Detailed file statistics */
  stats: FileStats;
  /** Git status for this file */
  gitStatus?: GitFileStatus;
}

/** Directory entry in the index */
export interface DirectoryEntry {
  /** Relative path from root */
  path: string;
  /** Absolute directory path */
  absolutePath: string;
  /** File paths contained (relative) */
  files: string[];
  /** Subdirectory paths (relative) */
  subdirectories: string[];
  /** Total size of all contained files */
  size: number;
  /** Last modification timestamp */
  modifiedAt: number;
}

/** Language statistics */
export interface LanguageStats {
  /** Language identifier (e.g., 'typescript', 'python') */
  language: string;
  /** Number of files */
  fileCount: number;
  /** Total lines of code */
  totalLines: number;
  /** Lines of actual code (excluding comments and blanks) */
  codeLines: number;
  /** Comment lines */
  commentLines: number;
  /** Blank/empty lines */
  blankLines: number;
  /** File extensions for this language */
  extensions: string[];
  /** Total file size in bytes */
  totalSize: number;
}

/** Git repository information */
export interface GitInfo {
  /** Whether this is a Git repository */
  isRepo: boolean;
  /** Git repository root path */
  rootPath?: string;
  /** Current branch name */
  currentBranch: string;
  /** Current HEAD commit */
  headCommit?: Commit;
  /** Remote origin URL */
  remoteUrl?: string;
  /** Number of commits ahead of remote */
  ahead?: number;
  /** Number of commits behind remote */
  behind?: number;
  /** Files not tracked by Git */
  untrackedFiles: string[];
  /** Files with unstaged changes */
  modifiedFiles: string[];
  /** Files with staged changes */
  stagedFiles: string[];
  /** Files with merge conflicts */
  conflictFiles: string[];
}

/** Git commit information */
export interface Commit {
  /** Full commit hash */
  hash: string;
  /** Short commit hash (7 chars) */
  shortHash: string;
  /** Commit message */
  message: string;
  /** Author name */
  author: string;
  /** Author email */
  email: string;
  /** Commit timestamp */
  timestamp: number;
  /** Files changed in this commit */
  filesChanged: string[];
  /** Number of insertions */
  insertions?: number;
  /** Number of deletions */
  deletions?: number;
}

/** Repository-wide statistics */
export interface RepoStats {
  /** Total number of files */
  totalFiles: number;
  /** Total number of directories */
  totalDirectories: number;
  /** Total size in bytes */
  totalSize: number;
  /** Total lines across all files */
  totalLines: number;
  /** Statistics by language */
  languages: LanguageStats[];
  /** File counts by extension */
  byExtension: Map<string, number>;
}

/** File statistics */
export interface FileStats {
  /** Total lines */
  totalLines: number;
  /** Lines of code (excluding comments and blanks) */
  codeLines: number;
  /** Comment lines */
  commentLines: number;
  /** Blank lines */
  blankLines: number;
}

/** Git file status */
export type GitFileStatus =
  | 'unmodified'
  | 'modified'
  | 'staged'
  | 'untracked'
  | 'ignored'
  | 'conflict';

/** Type of file change */
export type FileChangeType = 'added' | 'modified' | 'deleted';

/** File change event */
export interface FileChange {
  /** Relative file path */
  path: string;
  /** Type of change */
  type: FileChangeType;
  /** Previous content hash (for modified) */
  previousHash?: string;
  /** Current content hash (for added/modified) */
  currentHash?: string;
}

/** Callback for file change events */
export type FileChangeCallback = (changes: FileChange[]) => void | Promise<void>;

/** Dependency information */
export interface DependencyInfo {
  /** Package name */
  name: string;
  /** Version specification */
  version: string;
  /** Dependency type */
  type: 'production' | 'development' | 'peer' | 'optional';
  /** Source file (package.json, Cargo.toml, etc.) */
  source: string;
}

/** Language detection result */
export interface LanguageDetection {
  /** Detected language */
  language: string | null;
  /** Confidence score (0-1) */
  confidence: number;
  /** Detection method used */
  method: 'extension' | 'content' | 'shebang' | 'none';
}

/** Scan result */
export interface ScanResult {
  /** Whether scan succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
  /** Generated file index */
  index?: FileIndex;
  /** Files processed */
  filesProcessed: number;
  /** Time taken in milliseconds */
  durationMs: number;
  /** Errors encountered during scan */
  errors: ScanError[];
}

/** Scan error */
export interface ScanError {
  /** File or directory path */
  path: string;
  /** Error message */
  message: string;
  /** Error code */
  code?: string;
}

/** Ignore pattern configuration */
export interface IgnoreConfig {
  /** Patterns from .gitignore files */
  gitignore: string[];
  /** Custom ignore patterns */
  custom: string[];
  /** Whether negation patterns are enabled */
  allowNegation: boolean;
}

/**
 * Repository-specific context types
 * Extends shared types with repo-scanner integration
 */

import type {
  ContextFragment,
  FragmentType,
  CompressionLevel,
  CompressionStrategy,
} from '../types/context.js';

/**
 * File context with repo-specific metadata
 */
export interface FileContext extends ContextFragment {
  type: Extract<FragmentType, 'code' | 'doc'>;
  /** Relative path from repo root */
  relativePath: string;
  /** File language */
  language: string | null;
  /** Symbol names defined in file */
  definedSymbols: string[];
  /** Symbol names referenced */
  referencedSymbols: string[];
  /** File size in bytes */
  fileSize: number;
  /** Last modified timestamp */
  modifiedAt: number;
}

/**
 * Repository map structure
 */
export interface RepoMap {
  /** Root path */
  rootPath: string;
  /** File tree snapshot */
  fileTree: FileNode[];
  /** Symbol index */
  symbols: SymbolIndex;
  /** Generated timestamp */
  generatedAt: number;
}

/**
 * File node in repo tree
 */
export interface FileNode {
  /** Relative path */
  path: string;
  /** Node type */
  type: 'file' | 'directory';
  /** For files: size in bytes */
  size?: number;
  /** For directories: children */
  children?: FileNode[];
  /** Language identifier */
  language?: string;
}

/**
 * Symbol index mapping
 */
export interface SymbolIndex {
  /** Symbol name -> locations */
  definitions: Map<string, SymbolLocation[]>;
  /** Symbol name -> referencing files */
  references: Map<string, string[]>;
}

/**
 * Symbol location
 */
export interface SymbolLocation {
  /** File path */
  file: string;
  /** Line number (1-indexed) */
  line: number;
  /** Column number (1-indexed) */
  column: number;
  /** Symbol kind */
  kind: 'class' | 'function' | 'variable' | 'interface' | 'type' | 'other';
}

/**
 * Repo-aware compression configuration
 */
export interface RepoCompressionConfig {
  /** Base compression strategy */
  baseStrategy: CompressionStrategy;
  /** Always include these file patterns */
  includePatterns: string[];
  /** Exclude these file patterns */
  excludePatterns: string[];
  /** Preferred compression for specific languages */
  languageStrategies: Map<string, CompressionLevel>;
  /** Max file size to inline (larger files are summarized) */
  maxInlineSize: number;
}

/**
 * Compressed repo context output
 */
export interface RepoCompressedContext {
  /** Compressed content for model */
  content: string;
  /** Repo map reference */
  repoMap: RepoMap;
  /** Files included in context */
  includedFiles: string[];
  /** Files summarized/omitted */
  omittedFiles: string[];
  /** Compression metrics */
  metrics: {
    totalFiles: number;
    includedFiles: number;
    totalTokens: number;
    compressedTokens: number;
  };
}

// Symbol Import Index
// Thread 06: symbol-import-index
// Provides bi-directional mapping between symbols and their imports/exports

import * as ts from 'typescript';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname, relative, join } from 'path';
import type {
  SymbolId,
  SymbolDefinition,
  SymbolKind,
  ImportEntry,
  ExportEntry,
  FileIndexEntry,
  SymbolResolution,
  SymbolIndexConfig,
  IndexError,
  IndexResult,
} from '../types/symbol-index.js';

/** Generate unique symbol ID */
function makeSymbolId(filePath: string, name: string): SymbolId {
  return `${filePath}::${name}`;
}

/** Hash file content for caching */
function hashContent(content: string): string {
  return createHash('md5').update(content).digest('hex');
}

/** Default configuration */
const DEFAULT_CONFIG: Partial<SymbolIndexConfig> = {
  include: ['.ts', '.tsx', '.js', '.jsx'],
  exclude: ['node_modules', 'dist', 'build', '.git'],
  pathAliases: {},
};

/**
 * SymbolIndex maintains bi-directional mappings:
 * - symbol definitions ↔ locations
 * - files ↔ their imports
 * - symbols ↔ files that import them
 */
export class SymbolIndex {
  // Map: symbolId → definition
  private definitions = new Map<SymbolId, SymbolDefinition>();

  // Map: filePath → file entry (imports, exports, hash)
  private fileIndex = new Map<string, FileIndexEntry>();

  // Map: filePath → symbols defined in file
  private fileToSymbols = new Map<string, Set<SymbolId>>();

  // Map: symbolId → set of files that import it
  private reverseImports = new Map<SymbolId, Set<string>>();

  private config: SymbolIndexConfig;
  private errors: IndexError[] = [];

  constructor(config: SymbolIndexConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as SymbolIndexConfig;
  }

  /**
   * Build index from a list of file paths
   */
  async build(filePaths: string[]): Promise<IndexResult> {
    this.errors = [];
    let processed = 0;

    for (const filePath of filePaths) {
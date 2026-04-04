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
      if (this.shouldIncludeFile(filePath)) {
        await this.indexFile(filePath);
        processed++;
      }
    }

    return {
      success: this.errors.length === 0,
      errors: this.errors,
      filesProcessed: processed,
      symbolsIndexed: this.definitions.size,
    };
  }

  /**
   * Re-index a single file (for incremental updates)
   */
  async updateFile(filePath: string): Promise<void> {
    // Remove old entries for this file
    this.removeFile(filePath);
    // Re-index
    await this.indexFile(filePath);
  }

  /**
   * Remove a file from the index
   */
  removeFile(filePath: string): void {
    const entry = this.fileIndex.get(filePath);
    if (!entry) return;

    // Remove symbols defined in this file
    for (const symbolId of entry.definedSymbols) {
      this.definitions.delete(symbolId);
      this.reverseImports.delete(symbolId);
    }

    // Remove reverse import entries pointing to this file
    for (const imp of entry.imports) {
      if (imp.resolvedPath) {
        const targetSymbolId = makeSymbolId(imp.resolvedPath, imp.importedName);
        const importers = this.reverseImports.get(targetSymbolId);
        if (importers) {
          importers.delete(filePath);
        }
      }
    }

    this.fileIndex.delete(filePath);
    this.fileToSymbols.delete(filePath);
  }

  /**
   * Resolve a symbol name to its definition
   */
  resolveSymbol(name: string, fromFile: string): SymbolDefinition | null {
    // Check local file first
    const localSymbols = this.fileToSymbols.get(fromFile);
    if (localSymbols) {
      for (const symbolId of localSymbols) {
        const def = this.definitions.get(symbolId);
        if (def?.name === name) return def;
      }
    }

    // Check imports in this file
    const entry = this.fileIndex.get(fromFile);
    if (entry) {
      for (const imp of entry.imports) {
        if (imp.localName === name && imp.resolvedPath) {
          const symbolId = makeSymbolId(imp.resolvedPath, imp.importedName);
          return this.definitions.get(symbolId) ?? null;
        }
      }
    }

    return null;
  }

  /**
   * Get all imports for a file
   */
  getImports(filePath: string): ImportEntry[] {
    return this.fileIndex.get(filePath)?.imports ?? [];
  }

  /**
   * Get all files that import a given symbol
   */
  getImporters(symbolId: SymbolId): string[] {
    return Array.from(this.reverseImports.get(symbolId) ?? []);
  }

  /**
   * Get symbol IDs defined in a file
   */
  getSymbolsInFile(filePath: string): SymbolId[] {
    return Array.from(this.fileToSymbols.get(filePath) ?? []);
  }

  /**
   * Get definition for a symbol ID
   */
  getDefinition(symbolId: SymbolId): SymbolDefinition | undefined {
    return this.definitions.get(symbolId);
  }

  /**
   * Check if file should be included based on config
   */
  private shouldIncludeFile(filePath: string): boolean {
    const ext = filePath.slice(filePath.lastIndexOf('.'));
    if (!this.config.include.includes(ext)) return false;

    for (const pattern of this.config.exclude) {
      if (filePath.includes(pattern)) return false;
    }

    return true;
  }

  /**
   * Parse and index a single file
   */
  private async indexFile(filePath: string): Promise<void> {
    try {
      const content = readFileSync(filePath, 'utf-8');
      const contentHash = hashContent(content);

      // Check if already indexed and unchanged
      const existing = this.fileIndex.get(filePath);
      if (existing?.contentHash === contentHash) return;

      const sourceFile = ts.createSourceFile(
        filePath,
        content,
        ts.ScriptTarget.Latest,
        true
      );

      const imports: ImportEntry[] = [];
      const exports: ExportEntry[] = [];
      const definedSymbols: SymbolId[] = [];

      ts.forEachChild(sourceFile, (node) => {
        // Extract imports
        if (ts.isImportDeclaration(node)) {
          const importEntry = this.parseImport(node, filePath, sourceFile);
          imports.push(...importEntry);
        }

        // Extract exports
        if (this.isExport(node)) {
          const exportEntries = this.parseExport(node, filePath, sourceFile);
          exports.push(...exportEntries);
          for (const exp of exportEntries) {
            definedSymbols.push(exp.symbolId);
          }
        }
      });

      // Store file entry
      this.fileIndex.set(filePath, {
        filePath,
        contentHash,
        imports,
        exports,
        definedSymbols,
      });

      // Update file → symbols mapping
      this.fileToSymbols.set(filePath, new Set(definedSymbols));

      // Update reverse imports
      for (const imp of imports) {
        if (imp.resolvedPath) {
          const targetSymbolId = makeSymbolId(imp.resolvedPath, imp.importedName);
          if (!this.reverseImports.has(targetSymbolId)) {
            this.reverseImports.set(targetSymbolId, new Set());
          }
          this.reverseImports.get(targetSymbolId)!.add(filePath);
        }
      }
    } catch (err) {
      this.errors.push({
        filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Parse import declaration
   */
  private parseImport(
    node: ts.ImportDeclaration,
    filePath: string,
    sourceFile: ts.SourceFile
  ): ImportEntry[] {
    const entries: ImportEntry[] = [];
    const sourcePath = node.moduleSpecifier.getText(sourceFile).slice(1, -1);
    const resolvedPath = this.resolveImportPath(sourcePath, filePath);

    // Default import: import x from '...'
    if (node.importClause?.name) {
      const name = node.importClause.name.getText(sourceFile);
      entries.push({
        localName: name,
        importedName: name,
        sourcePath,
        resolvedPath,
        isDefault: true,
        isNamespace: false,
        location: this.getNodeLocation(node, sourceFile),
      });
    }

    // Named imports: import { x, y as z } from '...'
    if (node.importClause?.namedBindings) {
      const bindings = node.importClause.namedBindings;
      if (ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const localName = element.name.getText(sourceFile);
          const importedName = element.propertyName?.getText(sourceFile) ?? localName;
          entries.push({
            localName,
            importedName,
            sourcePath,
            resolvedPath,
            isDefault: false,
            isNamespace: false,
            location: this.getNodeLocation(node, sourceFile),
          });
        }
      }

      // Namespace import: import * as ns from '...'
      if (ts.isNamespaceImport(bindings)) {
        const localName = bindings.name.getText(sourceFile);
        entries.push({
          localName,
          importedName: '*',
          sourcePath,
          resolvedPath,
          isDefault: false,
          isNamespace: true,
          location: this.getNodeLocation(node, sourceFile),
        });
      }
    }

    return entries;
  }

  /**
   * Check if node is an export
   */
  private isExport(node: ts.Node): boolean {
    if (ts.isExportDeclaration(node)) return true;
    if (ts.isVariableStatement(node) || ts.isFunctionDeclaration(node)) {
      return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    }
    return false;
  }

  /**
   * Parse export declaration
   */
  private parseExport(
    node: ts.Node,
    filePath: string,
    sourceFile: ts.SourceFile
  ): ExportEntry[] {
    const entries: ExportEntry[] = [];

    // Named exports: export { x, y }
    if (ts.isExportDeclaration(node)) {
      const specifiers
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
      const specifiers = node.exportClause;
      if (specifiers && ts.isNamedExports(specifiers)) {
        for (const element of specifiers.elements) {
          const name = element.name.getText(sourceFile);
          const symbolId = makeSymbolId(filePath, name);

          // Create definition
          const def: SymbolDefinition = {
            id: symbolId,
            name,
            kind: 'const',
            location: this.getNodeLocation(node, sourceFile),
            isDefault: false,
            isNamed: true,
          };

          this.definitions.set(symbolId, def);
          entries.push({ symbolId });
        }
      }

      // Re-export: export { x } from './module'
      if (node.moduleSpecifier) {
        const reExportPath = node.moduleSpecifier.getText(sourceFile).slice(1, -1);
        const resolvedPath = this.resolveImportPath(reExportPath, filePath);

        if (specifiers && ts.isNamedExports(specifiers)) {
          for (const element of specifiers.elements) {
            const name = element.name.getText(sourceFile);
            const symbolId = makeSymbolId(resolvedPath ?? filePath, name);
            entries.push({ symbolId, reExportedFrom: reExportPath });
          }
        }
      }
    }

    // Exported function: export function foo()
    if (ts.isFunctionDeclaration(node) && node.name) {
      const name = node.name.getText(sourceFile);
      const symbolId = makeSymbolId(filePath, name);

      const def: SymbolDefinition = {
        id: symbolId,
        name,
        kind: 'function',
        location: this.getNodeLocation(node, sourceFile),
        isDefault: false,
        isNamed: true,
      };

      this.definitions.set(symbolId, def);
      entries.push({ symbolId });
    }

    // Exported variable: export const x = ...
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) {
          const name = decl.name.getText(sourceFile);
          const symbolId = makeSymbolId(filePath, name);

          const kind = this.inferSymbolKind(node, decl);
          const def: SymbolDefinition = {
            id: symbolId,
            name,
            kind,
            location: this.getNodeLocation(node, sourceFile),
            isDefault: false,
            isNamed: true,
          };

          this.definitions.set(symbolId, def);
          entries.push({ symbolId });
        }
      }
    }

    // Class/Interface/Enum declarations with export modifier
    if (
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isTypeAliasDeclaration(node)
    ) {
      if (node.name && this.hasExportModifier(node)) {
        const name = node.name.getText(sourceFile);
        const symbolId = makeSymbolId(filePath, name);

        const kind = this.getKindFromNode(node);
        const def: SymbolDefinition = {
          id: symbolId,
          name,
          kind,
          location: this.getNodeLocation(node, sourceFile),
          isDefault: false,
          isNamed: true,
        };

        this.definitions.set(symbolId, def);
        entries.push({ symbolId });
      }
    }

    // Default export: export default x
    if (ts.isExportAssignment(node)) {
      const name = node.expression.getText(sourceFile);
      const symbolId = makeSymbolId(filePath, name);

      // Mark existing definition as default
      const existing = this.definitions.get(symbolId);
      if (existing) {
        existing.isDefault = true;
        entries.push({ symbolId });
      }
    }

    return entries;
  }

  /**
   * Check if node has export modifier
   */
  private hasExportModifier(node: ts.Node): boolean {
    return node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
  }

  /**
   * Infer symbol kind from declaration
   */
  private inferSymbolKind(
    stmt: ts.VariableStatement,
    decl: ts.VariableDeclaration
  ): SymbolKind {
    if (decl.type) {
      const typeStr = decl.type.getText();
      if (typeStr.includes('=>')) return 'function';
    }
    return stmt.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
  }

  /**
   * Get symbol kind from node type
   */
  private getKindFromNode(node: ts.Node): SymbolKind {
    if (ts.isClassDeclaration(node)) return 'class';
    if (ts.isInterfaceDeclaration(node)) return 'interface';
    if (ts.isEnumDeclaration(node)) return 'enum';
    if (ts.isTypeAliasDeclaration(node)) return 'type';
    return 'const';
  }

  /**
   * Resolve import path to absolute path
   */
  private resolveImportPath(importPath: string, fromFile: string): string | undefined {
    // npm package imports
    if (!importPath.startsWith('.')) {
      return `npm:${importPath}`;
    }

    // Relative imports
    const dir = dirname(fromFile);

    // Check path aliases
    for (const [alias, targets] of Object.entries(this.config.pathAliases)) {
      const aliasPattern = alias.replace('/*', '');
      if (importPath.startsWith(aliasPattern)) {
        for (const target of targets) {
          const targetBase = target.replace('/*', '');
          const relativePart = importPath.slice(aliasPattern.length);
          const resolved = join(this.config.rootDir, targetBase, relativePart);

          // Try common extensions
          for (const ext of this.config.include) {
            const withExt = resolved + ext;
            if (existsSync(withExt)) return withExt;
          }

          // Try index file
          const indexFile = join(resolved, 'index');
          for (const ext of this.config.include) {
            const withExt = indexFile + ext;
            if (existsSync(withExt)) return withExt;
          }
        }
      }
    }

    // Resolve relative path
    const basePath = resolve(dir, importPath);

    for (const ext of this.config.include) {
      const withExt = basePath + ext;
      if (existsSync(withExt)) return withExt;
    }

    // Try index file
    const indexPath = join(basePath, 'index');
    for (const ext of this.config.include) {
      const withExt = indexPath + ext;
      if (existsSync(withExt)) return withExt;
    }

    return undefined;
  }

  /**
   * Get location info from AST node
   */
  private getNodeLocation(
    node: ts.Node,
    sourceFile: ts.SourceFile
  ): { filePath: string; line: number; column: number; length: number } {
    const pos = node.getSourceFile().getLineAndCharacterOfPosition(node.getStart());
    const end = node.getSourceFile().getLineAndCharacterOfPosition(node.getEnd());

    // Calculate length (simple approximation for single-line nodes)
    let length = node.getEnd() - node.getStart();
    if (ts.isIdentifier(node)) {
      length = node.text.length;
    }

    return {
      filePath: sourceFile.fileName,
      line: pos.line + 1,
      column: pos.character,
      length,
    };
  }

  /**
   * Serialize index to JSON for persistence
   */
  toJSON(): object {
    return {
      definitions: Object.fromEntries(this.definitions),
      fileIndex: Object.fromEntries(this.fileIndex),
      reverseImports: Object.fromEntries(
        Array.from(this.reverseImports.entries()).map(([k, v]) => [k, Array.from(v)])
      ),
    };
  }

  /**
   * Load index from JSON
   */
  static fromJSON(data: object): SymbolIndex {
    const index = new SymbolIndex({
      rootDir: '',
      include: ['.ts'],
      exclude: [],
      pathAliases: {},
    });

    const typed = data as {
      definitions?: Record<string, SymbolDefinition>;
      fileIndex?: Record<string, FileIndexEntry>;
      reverseImports?: Record<string, string[]>;
    };

    if (typed.definitions) {
      index.definitions = new Map(Object.entries(typed.definitions));
    }
    if (typed.fileIndex) {
      index.fileIndex = new Map(Object.entries(typed.fileIndex));
      // Rebuild derived maps
      for (const [filePath, entry] of index.fileIndex) {
        index.fileToSymbols.set(filePath, new Set(entry.definedSymbols));
      }
    }
    if (typed.reverseImports) {
      index.reverseImports = new Map(
        Object.entries(typed.reverseImports).map(([k, v]) => [k, new Set(v)])
      );
    }

    return index;
  }
}

// Factory function for convenience
export async function buildSymbolIndex(
  filePaths: string[],
  config: SymbolIndexConfig
): Promise<{ index: SymbolIndex; result: IndexResult }> {
  const index = new SymbolIndex(config);
  const result = await index.build(filePaths);
  return { index, result };
}

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
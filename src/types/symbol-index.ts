// Symbol Import Index Types
// Thread 06: symbol-import-index

/** Unique identifier for a symbol */
export type SymbolId = string;

/** Location of a symbol in source code */
export interface SymbolLocation {
  filePath: string;
  line: number;
  column: number;
  /** Length of the symbol name in characters */
  length: number;
}

/** Types of exportable symbols */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'interface'
  | 'type'
  | 'enum'
  | 'const'
  | 'let'
  | 'var';

/** Export information for a symbol */
export interface SymbolDefinition {
  id: SymbolId;
  name: string;
  kind: SymbolKind;
  location: SymbolLocation;
  /** True if exported via `export default` */
  isDefault: boolean;
  /** True if named export: `export { x }` or `export const x` */
  isNamed: boolean;
  /** JSDoc/tsdoc comment if present */
  documentation?: string;
}

/** Single import entry from a file */
export interface ImportEntry {
  /** Local binding name */
  localName: string;
  /** Original name (for renamed imports: import { x as y }) */
  importedName: string;
  /** Source module path (can be relative, alias, or npm package) */
  sourcePath: string;
  /** Resolved absolute path if known */
  resolvedPath?: string;
  /** Is default import */
  isDefault: boolean;
  /** Is namespace import: import * as ns */
  isNamespace: boolean;
  location: SymbolLocation;
}

/** Export entry from a file */
export interface ExportEntry {
  symbolId: SymbolId;
  /** For re-exports: source path */
  reExportedFrom?: string;
}

/** Index entry for a single file */
export interface FileIndexEntry {
  filePath: string;
  /** Content hash for cache invalidation */
  contentHash: string;
  imports: ImportEntry[];
  exports: ExportEntry[];
  /** Symbols defined in this file (resolved from exports) */
  definedSymbols: SymbolId[];
}

/** Query result for symbol resolution */
export interface SymbolResolution {
  definition: SymbolDefinition;
  /** Files that import this symbol */
  importedBy: string[];
}

/** Configuration for index building */
export interface SymbolIndexConfig {
  /** Project root directory */
  rootDir: string;
  /** Path to tsconfig.json (optional) */
  tsConfigPath?: string;
  /** File extensions to include */
  include: string[];
  /** Patterns to exclude */
  exclude: string[];
  /** Path aliases from tsconfig */
  pathAliases: Record<string, string[]>;
}

/** Error during index building */
export interface IndexError {
  filePath: string;
  message: string;
  line?: number;
  column?: number;
}

/** Result of index build/update operation */
export interface IndexResult {
  success: boolean;
  errors: IndexError[];
  filesProcessed: number;
  symbolsIndexed: number;
}

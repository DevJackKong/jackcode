/**
 * Impact Analyzer Types
 * Defines the contract for analyzing code change impact.
 */

/** Types of changes that can be analyzed */
export type ChangeType = 'add' | 'modify' | 'delete' | 'rename';

/** Granularity of the change */
export type ChangeScope = 'file' | 'symbol' | 'line-range';

/** Severity levels for impact assessment */
export type ImpactSeverity = 'critical' | 'high' | 'medium' | 'low' | 'none';

/** Categories of impacted code */
export type ImpactCategory = 'direct' | 'transitive' | 'test' | 'type-only' | 'dynamic';

/** Test execution priority */
export type TestPriority = 'critical' | 'high' | 'normal';

/** Estimated blast radius scope */
export type ImpactScope = 'unit' | 'integration' | 'e2e';

/**
 * Describes a single code change
 */
export interface ChangeDescriptor {
  /** Path to the changed file (relative to repo root) */
  path: string;
  /** Type of change */
  type: ChangeType;
  /** Scope granularity */
  scope: ChangeScope;
  /** Specific symbol name if scope is 'symbol' */
  symbolName?: string;
  /** Line range if scope is 'line-range' */
  lineRange?: { start: number; end: number };
  /** Previous path if this was a rename */
  previousPath?: string;
  /** Git diff content if available */
  diff?: string;
}

/**
 * A single impacted file entry
 */
export interface ImpactedFile {
  /** File path */
  path: string;
  /** How this file is impacted */
  category: ImpactCategory;
  /** Impact severity */
  severity: ImpactSeverity;
  /** Reasons why this file is impacted */
  reasons: string[];
  /** Distance from change (0 = direct, 1 = one hop, etc.) */
  distance: number;
  /** Specific symbols affected within this file */
  affectedSymbols?: string[];
  /** Estimated verification scope required for this file */
  scope?: ImpactScope;
  /** Whether this file sits on a critical path */
  criticalPath?: boolean;
  /** Per-file risk score */
  riskScore?: number;
}

/**
 * A test file that needs to run
 */
export interface AffectedTest {
  /** Test file path */
  path: string;
  /** Source files this test covers */
  coversFiles: string[];
  /** Priority for test execution */
  priority: TestPriority;
  /** Estimated scope of the test */
  scope: ImpactScope;
  /** Score used for ordering */
  estimatedImpact?: number;
  /** Why this test was selected */
  reasons?: string[];
}

export interface SymbolUsageReference {
  filePath: string;
  distance: number;
  importedAs?: string;
  importKind?: SymbolImport['kind'];
  isTypeOnly?: boolean;
}

export interface SymbolImpact {
  symbolName: string;
  exportedFrom: string;
  references: SymbolUsageReference[];
  rippleFiles: string[];
  directReferenceCount: number;
  transitiveReferenceCount: number;
  isBreakingChange: boolean;
  compatibility: 'backward-compatible' | 'potentially-breaking' | 'breaking';
  reasons: string[];
}

export interface TestSelection {
  minimal: AffectedTest[];
  recommended: AffectedTest[];
  byScope: Record<ImpactScope, AffectedTest[]>;
}

export interface RiskAssessment {
  level: 'low' | 'medium' | 'high';
  score: number;
  complexityScore: number;
  criticalPaths: string[];
  highRiskFiles: Array<{ path: string; score: number; reasons: string[] }>;
  mitigationSuggestions: string[];
}

/**
 * Complete impact analysis report
 */
export interface ImpactReport {
  /** Original changes analyzed */
  changes: ChangeDescriptor[];
  /** Timestamp of analysis */
  timestamp: number;
  /** All impacted files */
  impactedFiles: ImpactedFile[];
  /** Tests that should be run */
  affectedTests: AffectedTest[];
  /** Summary statistics */
  summary: {
    totalFilesImpacted: number;
    directImpacts: number;
    transitiveImpacts: number;
    testFilesImpacted: number;
    maxDistance: number;
    scope: ImpactScope;
    severity: ImpactSeverity;
    breakingChanges: number;
  };
  /** Estimated risk level */
  riskLevel: 'low' | 'medium' | 'high';
  /** Recommendations based on impact */
  recommendations: string[];
  /** Symbol-level usage and ripple information */
  symbolImpacts: SymbolImpact[];
  /** Structured test selection output */
  testSelection: TestSelection;
  /** Structured risk assessment output */
  riskAssessment: RiskAssessment;
}

/**
 * Node in the dependency graph
 */
export interface DependencyNode {
  /** File path */
  path: string;
  /** Symbols exported by this file */
  exports: SymbolExport[];
  /** Symbols imported by this file */
  imports: SymbolImport[];
  /** Files that import from this file (reverse dependencies) */
  dependents: string[];
  /** Last modified timestamp */
  lastModified: number;
}

/**
 * Exported symbol information
 */
export interface SymbolExport {
  /** Symbol name */
  name: string;
  /** Type of export */
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'const' | 'enum';
  /** Is this the default export */
  isDefault: boolean;
  /** Line number */
  line: number;
  /** Whether this is a type-only export */
  isTypeOnly: boolean;
}

/**
 * Imported symbol information
 */
export interface SymbolImport {
  /** Symbol name (or '*' for namespace) */
  name: string;
  /** Source module path */
  source: string;
  /** Type of import */
  kind: 'named' | 'default' | 'namespace' | 'side-effect';
  /** Whether this is a type-only import */
  isTypeOnly: boolean;
  /** Local alias if renamed */
  localName?: string;
}

/**
 * Options for impact analysis
 */
export interface ImpactAnalyzerOptions {
  /** Maximum traversal depth for transitive dependencies */
  maxDepth: number;
  /** Include test files in impact analysis */
  includeTests: boolean;
  /** Include type-only dependencies */
  includeTypeDependencies: boolean;
  /** Patterns to exclude from analysis */
  excludePatterns: string[];
  /** Test file patterns */
  testPatterns: string[];
  /** Repository root for relative path normalization */
  rootDir?: string;
}

/**
 * Default analyzer options
 */
export const DEFAULT_ANALYZER_OPTIONS: ImpactAnalyzerOptions = {
  maxDepth: 10,
  includeTests: true,
  includeTypeDependencies: true,
  excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
  testPatterns: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**', '**/*.test.js', '**/*.spec.js'],
  rootDir: process.cwd(),
};

/**
 * Interface for the impact analyzer
 */
export interface IImpactAnalyzer {
  /**
   * Analyze the impact of one or more changes
   */
  analyze(changes: ChangeDescriptor | ChangeDescriptor[]): Promise<ImpactReport>;

  /**
   * Invalidate cached dependency data for specific paths
   */
  invalidateCache(paths?: string[]): void;

  /**
   * Rebuild the entire dependency graph
   */
  rebuildGraph(): Promise<void>;

  /**
   * Get the dependency node for a file
   */
  getNode(path: string): DependencyNode | undefined;

  /**
   * Check if a file depends on another
   */
  hasDependency(from: string, to: string): boolean;
}

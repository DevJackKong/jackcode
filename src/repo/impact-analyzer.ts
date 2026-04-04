/**
 * Impact Analyzer
 * Analyzes the ripple effects of code changes across the codebase.
 */

import {
  ChangeDescriptor,
  ChangeType,
  ImpactReport,
  ImpactedFile,
  AffectedTest,
  ImpactCategory,
  ImpactSeverity,
  DependencyNode,
  SymbolExport,
  SymbolImport,
  ImpactAnalyzerOptions,
  DEFAULT_ANALYZER_OPTIONS,
  IImpactAnalyzer,
} from '../types/impact-analyzer.js';

/**
 * ImpactAnalyzer analyzes code changes to determine affected files,
 * symbols, and tests. Uses a dependency graph for efficient traversal.
 */
export class ImpactAnalyzer implements IImpactAnalyzer {
  private dependencyGraph: Map<string, DependencyNode> = new Map();
  private options: ImpactAnalyzerOptions;

  constructor(options: Partial<ImpactAnalyzerOptions> = {}) {
    this.options = { ...DEFAULT_ANALYZER_OPTIONS, ...options };
  }

  /**
   * Analyze the impact of one or more changes
   */
  async analyze(changes: ChangeDescriptor | ChangeDescriptor[]): Promise<ImpactReport> {
    const changeList = Array.isArray(changes) ? changes : [changes];
    const impactedFiles = new Map<string, ImpactedFile>();
    const affectedTests: AffectedTest[] = [];
    const timestamp = Date.now();

    // Process each change
    for (const change of changeList) {
      await this.analyzeSingleChange(change, impactedFiles);
    }

    // Find affected tests
    if (this.options.includeTests) {
      this.discoverAffectedTests(impactedFiles, affectedTests);
    }

    // Calculate summary
    const summary = this.calculateSummary(impactedFiles, affectedTests);

    // Determine risk level
    const riskLevel = this.assessRiskLevel(impactedFiles, affectedTests);

    // Generate recommendations
    const recommendations = this.generateRecommendations(impactedFiles, affectedTests, riskLevel);

    return {
      changes: changeList,
      timestamp,
      impactedFiles: Array.from(impactedFiles.values()).sort((a, b) => b.severity.localeCompare(a.severity)),
      affectedTests,
      summary,
      riskLevel,
      recommendations,
    };
  }

  /**
   * Analyze a single change and update the impacted files map
   */
  private async analyzeSingleChange(
    change: ChangeDescriptor,
    impactedFiles: Map<string, ImpactedFile>
  ): Promise<void> {
    // Mark the changed file as directly impacted
    this.addImpactedFile(impactedFiles, {
      path: change.path,
      category: 'direct',
      severity: this.severityFromChangeType(change.type),
      reasons: [`${change.type} operation on ${change.scope}`],
      distance: 0,
      affectedSymbols: change.symbolName ? [change.symbolName] : undefined,
    });

    // If previous path exists (rename), mark it too
    if (change.previousPath) {
      this.addImpactedFile(impactedFiles, {
        path: change.previousPath,
        category: 'direct',
        severity: 'high',
        reasons: ['file renamed from this path'],
        distance: 0,
      });
    }

    // Find transitive dependencies
    await this.propagateImpact(change.path, impactedFiles, 1);

    // If the change affects specific symbols, analyze symbol-level impact
    if (change.symbolName && change.scope === 'symbol') {
      await this.analyzeSymbolImpact(change.path, change.symbolName, impactedFiles);
    }
  }

  /**
   * Propagate impact through the dependency graph
   */
  private async propagateImpact(
    sourcePath: string,
    impactedFiles: Map<string, ImpactedFile>,
    distance: number
  ): Promise<void> {
    if (distance > this.options.maxDepth) {
      return;
    }

    const node = this.dependencyGraph.get(sourcePath);
    if (!node) {
      return;
    }

    // Find all files that depend on the source
    for (const dependentPath of node.dependents) {
      // Skip if already marked with lower distance
      const existing = impactedFiles.get(dependentPath);
      if (existing && existing.distance <= distance) {
        continue;
      }

      const dependentNode = this.dependencyGraph.get(dependentPath);
      const isTestFile = this.isTestFile(dependentPath);
      
      // Determine what symbols from source are used by dependent
      const usedSymbols = this.findUsedSymbols(node, dependentNode);

      this.addImpactedFile(impactedFiles, {
        path: dependentPath,
        category: isTestFile ? 'test' : 'transitive',
        severity: this.calculateTransitiveSeverity(distance, isTestFile),
        reasons: [`depends on ${sourcePath}`],
        distance,
        affectedSymbols: usedSymbols.length > 0 ? usedSymbols : undefined,
      });

      // Continue propagation
      await this.propagateImpact(dependentPath, impactedFiles, distance + 1);
    }
  }

  /**
   * Analyze impact at symbol level
   */
  private async analyzeSymbolImpact(
    filePath: string,
    symbolName: string,
    impactedFiles: Map<string, ImpactedFile>
  ): Promise<void> {
    const node = this.dependencyGraph.get(filePath);
    if (!node) {
      return;
    }

    // Find symbol export info
    const symbolExport = node.exports.find(e => e.name === symbolName);
    if (!symbolExport) {
      return;
    }

    // For type-only exports, reduce severity of transitive impacts
    if (symbolExport.isTypeOnly) {
      for (const [path, file] of impactedFiles) {
        if (file.category === 'transitive' && file.distance > 0) {
          // Downgrade severity for type-only impacts at runtime
          if (!this.options.includeTypeDependencies) {
            impactedFiles.delete(path);
          } else {
            file.category = 'type-only';
            file.severity = 'low';
          }
        }
      }
    }
  }

  /**
   * Find which symbols from source are used by dependent
   */
  private findUsedSymbols(sourceNode: DependencyNode, dependentNode?: DependencyNode): string[] {
    if (!dependentNode) {
      return [];
    }

    const usedSymbols: string[] = [];
    for (const imp of dependentNode.imports) {
      // Resolve the import source to absolute path
      const resolvedSource = this.resolveImportPath(imp.source, dependentNode.path);
      if (resolvedSource === sourceNode.path) {
        if (imp.name === '*') {
          // Namespace import - all exports used
          usedSymbols.push(...sourceNode.exports.map(e => e.name));
        } else {
          usedSymbols.push(imp.localName || imp.name);
        }
      }
    }
    return usedSymbols;
  }

  /**
   * Resolve an import path to absolute file path
   * Stub implementation - should use actual module resolution
   */
  private resolveImportPath(importPath: string, fromFile: string): string {
    // Handle relative imports
    if (importPath.startsWith('.')) {
      // Simple resolution - real implementation would use proper path resolution
      return importPath; // Placeholder
    }
    // Handle node_modules or other imports
    return importPath;
  }

  /**
   * Discover which tests are affected by the changes
   */
  private discoverAffectedTests(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[]
  ): void {
    const testFiles: AffectedTest[] = [];
    const seenTests = new Set<string>();

    for (const [path, file] of impactedFiles) {
      // Skip if already a test file
      if (this.isTestFile(path)) {
        continue;
      }

      // Find tests that cover this file
      const coveringTests = this.findCoveringTests(path);
      for (const testPath of coveringTests) {
        if (seenTests.has(testPath)) {
          continue;
        }
        seenTests.add(testPath);

        testFiles.push({
          path: testPath,
          coversFiles: [path],
          priority: this.calculateTestPriority(file),
          scope: this.inferTestScope(testPath),
        });
      }
    }

    affectedTests.push(...testFiles);
  }


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

  /**
   * Helper: Add or update an impacted file
   */
  private addImpactedFile(
    impactedFiles: Map<string, ImpactedFile>,
    file: ImpactedFile
  ): void {
    const existing = impactedFiles.get(file.path);
    if (existing) {
      // Merge with existing entry
      existing.category = this.mergeCategory(existing.category, file.category);
      existing.severity = this.higherSeverity(existing.severity, file.severity);
      existing.reasons = [...new Set([...existing.reasons, ...file.reasons])];
      existing.distance = Math.min(existing.distance, file.distance);
      if (file.affectedSymbols) {
        existing.affectedSymbols = [...new Set([...(existing.affectedSymbols || []), ...file.affectedSymbols])];
      }
    } else {
      impactedFiles.set(file.path, file);
    }
  }

  /**
   * Calculate severity from change type
   */
  private severityFromChangeType(type: ChangeType): ImpactSeverity {
    switch (type) {
      case 'delete':
        return 'critical';
      case 'rename':
        return 'high';
      case 'modify':
        return 'high';
      case 'add':
        return 'medium';
      default:
        return 'medium';
    }
  }

  /**
   * Calculate severity for transitive impact
   */
  private calculateTransitiveSeverity(distance: number, isTest: boolean): ImpactSeverity {
    if (isTest) {
      return 'low';
    }
    if (distance <= 1) {
      return 'high';
    }
    if (distance <= 3) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Merge two impact categories (prefer more specific)
   */
  private mergeCategory(a: ImpactCategory, b: ImpactCategory): ImpactCategory {
    const priority: ImpactCategory[] = ['direct', 'transitive', 'test', 'type-only', 'dynamic'];
    const aIdx = priority.indexOf(a);
    const bIdx = priority.indexOf(b);
    return priority[Math.min(aIdx, bIdx)];
  }

  /**
   * Return the higher severity
   */
  private higherSeverity(a: ImpactSeverity, b: ImpactSeverity): ImpactSeverity {
    const order: ImpactSeverity[] = ['critical', 'high', 'medium', 'low', 'none'];
    return order[Math.min(order.indexOf(a), order.indexOf(b))];
  }

  /**
   * Check if a file is a test file
   */
  private isTestFile(path: string): boolean {
    return this.options.testPatterns.some(pattern => {
      // Simple glob matching - real implementation would use proper glob
      const regex = pattern
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*')
        .replace(/\?/g, '.');
      return new RegExp(regex).test(path);
    });
  }

  /**
   * Find tests that cover a given source file
   * Stub implementation - should integrate with test mapping
   */
  private findCoveringTests(sourcePath: string): string[] {
    // This would integrate with a test coverage mapping system
    // For now, return empty - real implementation would:
    // 1. Check coverage data if available
    // 2. Look for tests in same directory
    // 3. Check test file naming conventions
    return [];
  }

  /**
   * Calculate test priority based on impacted file
   */
  private calculateTestPriority(file: ImpactedFile): 'critical' | 'high' | 'normal' {
    if (file.severity === 'critical') {
      return 'critical';
    }
    if (file.severity === 'high' || file.distance <= 1) {
      return 'high';
    }
    return 'normal';
  }

  /**
   * Infer test scope from test file path
   */
  private inferTestScope(testPath: string): 'unit' | 'integration' | 'e2e' {
    const lower = testPath.toLowerCase();
    if (lower.includes('e2e') || lower.includes('end-to-end') || lower.includes('integration')) {
      return 'e2e';
    }
    if (lower.includes('integration')) {
      return 'integration';
    }
    return 'unit';
  }

  /**
   * Calculate summary statistics
   */
  private calculateSummary(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[]
  ): ImpactReport['summary'] {
    const files = Array.from(impactedFiles.values());
    const directImpacts = files.filter(f => f.category === 'direct').length;
    const transitiveImpacts = files.filter(f => f.category === 'transitive').length;
    const testFilesImpacted = files.filter(f => f.category === 'test').length;
    const maxDistance = files.length > 0 ? Math.max(...files.map(f => f.distance)) : 0;

    return {
      totalFilesImpacted: files.length,
      directImpacts,
      transitiveImpacts,
      testFilesImpacted,
      maxDistance,
    };
  }

  /**
   * Assess overall risk level
   */
  private assessRiskLevel(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[]
  ): 'low' | 'medium' | 'high' {
    const files = Array.from(impactedFiles.values());

    // Critical severity found
    if (files.some(f => f.severity === 'critical')) {
      return 'high';
    }

    // Many high severity or transitive impacts
    const highSeverityCount = files.filter(f => f.severity === 'high').length;
    if (highSeverityCount > 5 || files.length > 20) {
      return 'high';
    }

    // Moderate impact
    if (highSeverityCount > 0 || files.length > 5) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Generate recommendations based on impact
   */
  private generateRecommendations(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[],
    riskLevel: 'low' | 'medium' | 'high'
  ): string[] {
    const recommendations: string[] = [];
    const files = Array.from(impactedFiles.values());

    if (riskLevel === 'high') {
      recommendations.push('Run full test suite due to high impact changes');
      recommendations.push('Consider incremental rollout or feature flags');
    }

    if (files.some(f => f.category === 'transitive' && f.distance > 3)) {
      recommendations.push('Deep dependency chain detected - review for potential circular dependencies');
    }

    if (affectedTests.length === 0) {
      recommendations.push('No tests detected for changed files - consider adding test coverage');
    }

    const criticalFiles = files.filter(f => f.severity === 'critical');
    if (criticalFiles.length > 0) {
      recommendations.push(`Review ${criticalFiles.length} critical impact(s) before merging`);
    }

    return recommendations;
  }

  // Public API methods

  /**
   * Invalidate cached dependency data for specific paths
   */
  invalidateCache(paths?: string[]): void {
    if (paths) {
      for (const path of paths) {
        this.dependencyGraph.delete(path);
      }
    } else {
      this.dependencyGraph.clear();
    }
  }

  /**
   * Rebuild the entire dependency graph
   * Stub - requires integration with repo scanner and symbol index
   */
  async rebuildGraph(): Promise<void> {
    // This would integrate with:
    // 1. RepoScanner to find all source files
    // 2. SymbolIndex to parse imports/exports
    // For now, clear the cache
    this.dependencyGraph.clear();
  }

  /**
   * Get the dependency node for a file
   */
  getNode(path: string): DependencyNode | undefined {
    return this.dependencyGraph.get(path);
  }

  /**
   * Check if a file depends on another
   */
  hasDependency(from: string, to: string): boolean {
    const fromNode = this.dependencyGraph.get(from);
    if (!fromNode) {
      return false;
    }
    return fromNode.imports.some(imp => this.resolveImportPath(imp.source, from) === to);
  }

  /**
   * Add or update a node in the dependency graph
   * Called by external systems (symbol index, repo scanner)
   */
  updateNode(node: DependencyNode): void {
    this.dependencyGraph.set(node.path, node);
  }

  /**
   * Get all registered nodes
   */
  getAllNodes(): Map<string, DependencyNode> {
    return new Map(this.dependencyGraph);
  }
}

// Factory function for creating analyzer instances
export function createImpactAnalyzer(options?: Partial<ImpactAnalyzerOptions>): ImpactAnalyzer {
  return new ImpactAnalyzer(options);
}


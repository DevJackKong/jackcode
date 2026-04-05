/**
 * Impact Analyzer
 * Analyzes the ripple effects of code changes across the codebase.
 */

import { dirname, normalize, resolve } from 'path';
import {
  ChangeDescriptor,
  ChangeType,
  ImpactReport,
  ImpactedFile,
  AffectedTest,
  ImpactCategory,
  ImpactSeverity,
  DependencyNode,
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
  private readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];

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

    for (const change of changeList) {
      await this.analyzeSingleChange(change, impactedFiles);
    }

    if (this.options.includeTests) {
      this.discoverAffectedTests(impactedFiles, affectedTests);
    }

    const summary = this.calculateSummary(impactedFiles, affectedTests);
    const riskLevel = this.assessRiskLevel(impactedFiles, affectedTests);
    const recommendations = this.generateRecommendations(impactedFiles, affectedTests, riskLevel);

    return {
      changes: changeList,
      timestamp,
      impactedFiles: Array.from(impactedFiles.values()).sort(
        (a, b) => this.severityRank(a.severity) - this.severityRank(b.severity) || a.distance - b.distance
      ),
      affectedTests,
      summary,
      riskLevel,
      recommendations,
    };
  }

  private async analyzeSingleChange(
    change: ChangeDescriptor,
    impactedFiles: Map<string, ImpactedFile>
  ): Promise<void> {
    const normalizedPath = this.normalizePath(change.path);

    this.addImpactedFile(impactedFiles, {
      path: normalizedPath,
      category: 'direct',
      severity: this.severityFromChangeType(change.type),
      reasons: [`${change.type} operation on ${change.scope}`],
      distance: 0,
      affectedSymbols: change.symbolName ? [change.symbolName] : undefined,
    });

    if (change.previousPath) {
      this.addImpactedFile(impactedFiles, {
        path: this.normalizePath(change.previousPath),
        category: 'direct',
        severity: 'high',
        reasons: ['file renamed from this path'],
        distance: 0,
      });
    }

    await this.propagateImpact(normalizedPath, impactedFiles, 1);

    if (change.symbolName && change.scope === 'symbol') {
      await this.analyzeSymbolImpact(normalizedPath, change.symbolName, impactedFiles);
    }
  }

  private async propagateImpact(
    sourcePath: string,
    impactedFiles: Map<string, ImpactedFile>,
    distance: number,
    visited = new Set<string>()
  ): Promise<void> {
    if (distance > this.options.maxDepth) {
      return;
    }

    const normalizedSourcePath = this.normalizePath(sourcePath);
    if (visited.has(normalizedSourcePath)) {
      return;
    }
    visited.add(normalizedSourcePath);

    const node = this.dependencyGraph.get(normalizedSourcePath);
    if (!node) {
      visited.delete(normalizedSourcePath);
      return;
    }

    for (const dependentPath of node.dependents) {
      const normalizedDependentPath = this.normalizePath(dependentPath);
      const existing = impactedFiles.get(normalizedDependentPath);
      if (existing && existing.distance <= distance) {
        continue;
      }

      const dependentNode = this.dependencyGraph.get(normalizedDependentPath);
      const isTestFile = this.isTestFile(normalizedDependentPath);
      const usedSymbols = this.findUsedSymbols(node, dependentNode);
      const circularDependency = visited.has(normalizedDependentPath);

      this.addImpactedFile(impactedFiles, {
        path: normalizedDependentPath,
        category: isTestFile ? 'test' : 'transitive',
        severity: circularDependency ? 'high' : this.calculateTransitiveSeverity(distance, isTestFile),
        reasons: circularDependency
          ? [`circular dependency detected with ${normalizedSourcePath}`]
          : [`depends on ${normalizedSourcePath}`],
        distance,
        affectedSymbols: usedSymbols.length > 0 ? usedSymbols : undefined,
      });

      if (!circularDependency) {
        await this.propagateImpact(normalizedDependentPath, impactedFiles, distance + 1, visited);
      }
    }

    visited.delete(normalizedSourcePath);
  }

  private async analyzeSymbolImpact(
    filePath: string,
    symbolName: string,
    impactedFiles: Map<string, ImpactedFile>
  ): Promise<void> {
    const node = this.dependencyGraph.get(this.normalizePath(filePath));
    if (!node) {
      return;
    }

    const symbolExport = node.exports.find((e) => e.name === symbolName);
    if (!symbolExport) {
      return;
    }

    if (symbolExport.isTypeOnly) {
      for (const [path, file] of impactedFiles) {
        if (file.category === 'transitive' && file.distance > 0) {
          if (!this.options.includeTypeDependencies) {
            impactedFiles.delete(path);
          } else {
            file.category = 'type-only';
            file.severity = 'low';
            file.reasons = [...new Set([...file.reasons, `type-only dependency on ${symbolName}`])];
          }
        }
      }
    }
  }

  private findUsedSymbols(sourceNode: DependencyNode, dependentNode?: DependencyNode): string[] {
    if (!dependentNode) {
      return [];
    }

    const usedSymbols = new Set<string>();
    for (const imp of dependentNode.imports) {
      if (imp.isTypeOnly && !this.options.includeTypeDependencies) {
        continue;
      }

      const resolvedSource = this.resolveImportPath(imp.source, dependentNode.path);
      if (resolvedSource === this.normalizePath(sourceNode.path)) {
        if (imp.name === '*') {
          for (const exported of sourceNode.exports) {
            if (!exported.isTypeOnly || this.options.includeTypeDependencies) {
              usedSymbols.add(exported.name);
            }
          }
        } else {
          usedSymbols.add(imp.name);
        }
      }
    }

    return Array.from(usedSymbols);
  }

  private resolveImportPath(importPath: string, fromFile: string): string {
    if (!importPath) {
      return this.normalizePath(fromFile);
    }

    if (!importPath.startsWith('.')) {
      return importPath;
    }

    const fromDir = dirname(this.normalizePath(fromFile));
    const basePath = this.normalizePath(resolve(fromDir, importPath));
    const candidates = [
      basePath,
      ...this.fileExtensions.map((ext) => `${basePath}${ext}`),
      ...this.fileExtensions.map((ext) => `${basePath}/index${ext}`),
    ];

    for (const candidate of candidates) {
      if (this.dependencyGraph.has(candidate)) {
        return candidate;
      }
    }

    return basePath;
  }

  private discoverAffectedTests(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[]
  ): void {
    const seenTests = new Map<string, AffectedTest>();

    for (const [path, file] of impactedFiles) {
      if (this.isTestFile(path)) {
        continue;
      }

      const coveringTests = this.findCoveringTests(path);
      for (const testPath of coveringTests) {
        const existing = seenTests.get(testPath);
        if (existing) {
          existing.coversFiles = Array.from(new Set([...existing.coversFiles, path]));
          existing.priority = this.higherTestPriority(existing.priority, this.calculateTestPriority(file));
          continue;
        }

        seenTests.set(testPath, {
          path: testPath,
          coversFiles: [path],
          priority: this.calculateTestPriority(file),
          scope: this.inferTestScope(testPath),
        });
      }
    }

    affectedTests.push(...seenTests.values());
  }

  private addImpactedFile(
    impactedFiles: Map<string, ImpactedFile>,
    file: ImpactedFile
  ): void {
    const normalizedPath = this.normalizePath(file.path);
    const nextFile = { ...file, path: normalizedPath };
    const existing = impactedFiles.get(normalizedPath);

    if (existing) {
      existing.category = this.mergeCategory(existing.category, nextFile.category);
      existing.severity = this.higherSeverity(existing.severity, nextFile.severity);
      existing.reasons = [...new Set([...existing.reasons, ...nextFile.reasons])];
      existing.distance = Math.min(existing.distance, nextFile.distance);
      if (nextFile.affectedSymbols) {
        existing.affectedSymbols = [
          ...new Set([...(existing.affectedSymbols || []), ...nextFile.affectedSymbols]),
        ];
      }
      return;
    }

    impactedFiles.set(normalizedPath, nextFile);
  }

  private severityFromChangeType(type: ChangeType): ImpactSeverity {
    switch (type) {
      case 'delete':
        return 'critical';
      case 'rename':
      case 'modify':
        return 'high';
      case 'add':
      default:
        return 'medium';
    }
  }

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

  private mergeCategory(a: ImpactCategory, b: ImpactCategory): ImpactCategory {
    const priority: ImpactCategory[] = ['direct', 'transitive', 'test', 'type-only', 'dynamic'];
    return priority[Math.min(priority.indexOf(a), priority.indexOf(b))] ?? a;
  }

  private higherSeverity(a: ImpactSeverity, b: ImpactSeverity): ImpactSeverity {
    const order: ImpactSeverity[] = ['critical', 'high', 'medium', 'low', 'none'];
    return order[Math.min(order.indexOf(a), order.indexOf(b))] ?? a;
  }

  private severityRank(severity: ImpactSeverity): number {
    return ['critical', 'high', 'medium', 'low', 'none'].indexOf(severity);
  }

  private isTestFile(path: string): boolean {
    return this.options.testPatterns.some((pattern) => this.matchPattern(path, pattern));
  }

  private findCoveringTests(sourcePath: string): string[] {
    const normalizedSourcePath = this.normalizePath(sourcePath);
    const sourceBase = normalizedSourcePath.replace(/\.[^.]+$/, '');
    const sourceFileName = sourceBase.split('/').pop() ?? sourceBase;
    const tests = new Set<string>();

    for (const [candidatePath, node] of this.dependencyGraph.entries()) {
      if (!this.isTestFile(candidatePath)) {
        continue;
      }

      const normalizedCandidate = this.normalizePath(candidatePath);
      const candidateBase = normalizedCandidate.replace(/\.[^.]+$/, '');
      if (
        candidateBase.includes(sourceFileName) ||
        node.imports.some((imp) => this.resolveImportPath(imp.source, node.path) === normalizedSourcePath)
      ) {
        tests.add(normalizedCandidate);
      }
    }

    return Array.from(tests);
  }

  private calculateTestPriority(file: ImpactedFile): 'critical' | 'high' | 'normal' {
    if (file.severity === 'critical') {
      return 'critical';
    }
    if (file.severity === 'high' || file.distance <= 1) {
      return 'high';
    }
    return 'normal';
  }

  private higherTestPriority(
    a: 'critical' | 'high' | 'normal',
    b: 'critical' | 'high' | 'normal'
  ): 'critical' | 'high' | 'normal' {
    const order = ['critical', 'high', 'normal'] as const;
    return order[Math.min(order.indexOf(a), order.indexOf(b))] ?? a;
  }

  private inferTestScope(testPath: string): 'unit' | 'integration' | 'e2e' {
    const lower = testPath.toLowerCase();
    if (lower.includes('e2e') || lower.includes('end-to-end')) {
      return 'e2e';
    }
    if (lower.includes('integration') || lower.includes('__integration__')) {
      return 'integration';
    }
    return 'unit';
  }

  private calculateSummary(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[]
  ): ImpactReport['summary'] {
    const files = Array.from(impactedFiles.values());
    const directImpacts = files.filter((f) => f.category === 'direct').length;
    const transitiveImpacts = files.filter((f) => f.category === 'transitive').length;
    const testFilesImpacted = files.filter((f) => f.category === 'test').length + affectedTests.length;
    const maxDistance = files.length > 0 ? Math.max(...files.map((f) => f.distance)) : 0;

    return {
      totalFilesImpacted: files.length,
      directImpacts,
      transitiveImpacts,
      testFilesImpacted,
      maxDistance,
    };
  }

  private assessRiskLevel(
    impactedFiles: Map<string, ImpactedFile>,
    _affectedTests: AffectedTest[]
  ): 'low' | 'medium' | 'high' {
    const files = Array.from(impactedFiles.values());

    if (files.some((f) => f.severity === 'critical')) {
      return 'high';
    }

    const highSeverityCount = files.filter((f) => f.severity === 'high').length;
    if (highSeverityCount > 5 || files.length > 20) {
      return 'high';
    }

    if (highSeverityCount > 0 || files.length > 5) {
      return 'medium';
    }

    return 'low';
  }

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

    if (files.some((f) => f.reasons.some((reason) => reason.includes('circular dependency')))) {
      recommendations.push('Circular dependency detected - review import boundaries before merging');
    }

    if (files.some((f) => f.category === 'transitive' && f.distance > 3)) {
      recommendations.push('Deep dependency chain detected - review for potential circular dependencies');
    }

    if (affectedTests.length === 0) {
      recommendations.push('No tests detected for changed files - consider adding test coverage');
    }

    const criticalFiles = files.filter((f) => f.severity === 'critical');
    if (criticalFiles.length > 0) {
      recommendations.push(`Review ${criticalFiles.length} critical impact(s) before merging`);
    }

    return recommendations;
  }

  invalidateCache(paths?: string[]): void {
    if (paths) {
      for (const path of paths) {
        this.dependencyGraph.delete(this.normalizePath(path));
      }
      return;
    }

    this.dependencyGraph.clear();
  }

  async rebuildGraph(): Promise<void> {
    this.dependencyGraph.clear();
  }

  getNode(path: string): DependencyNode | undefined {
    return this.dependencyGraph.get(this.normalizePath(path));
  }

  hasDependency(from: string, to: string): boolean {
    const normalizedFrom = this.normalizePath(from);
    const normalizedTo = this.normalizePath(to);
    const fromNode = this.dependencyGraph.get(normalizedFrom);
    if (!fromNode) {
      return false;
    }
    return fromNode.imports.some((imp) => this.resolveImportPath(imp.source, normalizedFrom) === normalizedTo);
  }

  updateNode(node: DependencyNode): void {
    const normalizedNode: DependencyNode = {
      ...node,
      path: this.normalizePath(node.path),
      dependents: node.dependents.map((p) => this.normalizePath(p)),
      imports: node.imports.map((imp) => ({ ...imp })),
      exports: node.exports.map((exp) => ({ ...exp })),
    };

    this.dependencyGraph.set(normalizedNode.path, normalizedNode);
  }

  getAllNodes(): Map<string, DependencyNode> {
    return new Map(this.dependencyGraph);
  }

  private normalizePath(filePath: string): string {
    return normalize(filePath).replace(/\\/g, '/');
  }

  private matchPattern(value: string, pattern: string): boolean {
    const normalizedValue = this.normalizePath(value);
    const escapedPattern = this.normalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexPattern = escapedPattern
      .replace(/\*\*/g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/::GLOBSTAR::/g, '.*');

    return new RegExp(`^${regexPattern}$`).test(normalizedValue);
  }
}

export function createImpactAnalyzer(options?: Partial<ImpactAnalyzerOptions>): ImpactAnalyzer {
  return new ImpactAnalyzer(options);
}

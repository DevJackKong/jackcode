/**
 * Impact Analyzer
 * Analyzes the ripple effects of code changes across the codebase.
 */

import { dirname, normalize, relative, resolve } from 'path';
import {
  ChangeDescriptor,
  ChangeType,
  ImpactReport,
  ImpactedFile,
  AffectedTest,
  ImpactCategory,
  ImpactScope,
  ImpactSeverity,
  DependencyNode,
  ImpactAnalyzerOptions,
  DEFAULT_ANALYZER_OPTIONS,
  IImpactAnalyzer,
  RiskAssessment,
  SymbolImpact,
  SymbolUsageReference,
  TestPriority,
  TestSelection,
} from '../types/impact-analyzer.js';
import type { SymbolIndex } from './symbol-index.js';
import type { RepoScanner } from '../core/scanner.js';
import type { FileIndex } from '../types/scanner.js';

/**
 * ImpactAnalyzer analyzes code changes to determine affected files,
 * symbols, and tests. Uses a dependency graph for efficient traversal.
 */
export class ImpactAnalyzer implements IImpactAnalyzer {
  private dependencyGraph: Map<string, DependencyNode> = new Map();
  private options: ImpactAnalyzerOptions;
  private readonly fileExtensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'];
  private symbolIndex?: SymbolIndex;
  private repoScanner?: RepoScanner;
  private scannerIndex?: FileIndex | null;

  constructor(options: Partial<ImpactAnalyzerOptions> = {}) {
    this.options = { ...DEFAULT_ANALYZER_OPTIONS, ...options };
  }

  /**
   * Analyze the impact of one or more changes
   */
  async analyze(changes: ChangeDescriptor | ChangeDescriptor[]): Promise<ImpactReport> {
    const changeList = Array.isArray(changes) ? changes : [changes];
    const impactedFiles = new Map<string, ImpactedFile>();
    const symbolImpacts: SymbolImpact[] = [];
    const timestamp = Date.now();

    await this.ensureGraphReady();

    for (const change of changeList) {
      await this.analyzeSingleChange(change, impactedFiles, symbolImpacts);
    }

    this.enrichImpactedFiles(impactedFiles, symbolImpacts, changeList);

    const affectedTests = this.options.includeTests
      ? this.discoverAffectedTests(impactedFiles, symbolImpacts)
      : [];

    const testSelection = this.buildTestSelection(affectedTests);
    const riskAssessment = this.buildRiskAssessment(impactedFiles, affectedTests, symbolImpacts, changeList);
    const summary = this.calculateSummary(impactedFiles, affectedTests, symbolImpacts);
    const recommendations = this.generateRecommendations(
      impactedFiles,
      testSelection,
      riskAssessment,
      symbolImpacts,
      changeList
    );

    return {
      changes: changeList,
      timestamp,
      impactedFiles: this.sortImpactedFiles(Array.from(impactedFiles.values())),
      affectedTests: this.sortTests(affectedTests),
      summary,
      riskLevel: riskAssessment.level,
      recommendations,
      symbolImpacts: symbolImpacts.sort(
        (a, b) => this.compatibilityRank(a.compatibility) - this.compatibilityRank(b.compatibility)
          || b.transitiveReferenceCount - a.transitiveReferenceCount
      ),
      testSelection,
      riskAssessment,
    };
  }

  private async analyzeSingleChange(
    change: ChangeDescriptor,
    impactedFiles: Map<string, ImpactedFile>,
    symbolImpacts: SymbolImpact[]
  ): Promise<void> {
    const normalizedPath = this.normalizePath(change.path);

    this.addImpactedFile(impactedFiles, {
      path: normalizedPath,
      category: 'direct',
      severity: this.severityFromChangeType(change.type),
      reasons: [`${change.type} operation on ${change.scope}`],
      distance: 0,
      affectedSymbols: change.symbolName ? [change.symbolName] : undefined,
      scope: this.classifyScope(normalizedPath, 0, false),
    });

    if (change.previousPath) {
      this.addImpactedFile(impactedFiles, {
        path: this.normalizePath(change.previousPath),
        category: 'direct',
        severity: change.type === 'rename' ? 'critical' : 'high',
        reasons: ['file renamed from this path'],
        distance: 0,
        scope: this.classifyScope(change.previousPath, 0, false),
      });
    }

    await this.propagateImpact(normalizedPath, impactedFiles, 1);

    const symbols = this.getChangedSymbols(change, normalizedPath);
    for (const symbolName of symbols) {
      const symbolImpact = this.analyzeSymbolImpact(normalizedPath, symbolName, change, impactedFiles);
      if (symbolImpact) {
        symbolImpacts.push(symbolImpact);
      }
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
    if (visited.has(normalizedSourcePath) || this.shouldExclude(normalizedSourcePath)) {
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
      if (this.shouldExclude(normalizedDependentPath)) {
        continue;
      }

      const existing = impactedFiles.get(normalizedDependentPath);
      if (existing && existing.distance <= distance) {
        continue;
      }

      const dependentNode = this.dependencyGraph.get(normalizedDependentPath);
      const isTestFile = this.isTestFile(normalizedDependentPath);
      const usedSymbols = this.findUsedSymbols(node, dependentNode);
      if (!this.options.includeTypeDependencies && dependentNode && usedSymbols.length === 0) {
        continue;
      }
      const circularDependency = visited.has(normalizedDependentPath);
      const category = this.classifyCategory(dependentNode, isTestFile, usedSymbols);

      this.addImpactedFile(impactedFiles, {
        path: normalizedDependentPath,
        category,
        severity: circularDependency
          ? 'high'
          : this.calculateTransitiveSeverity(distance, isTestFile, category),
        reasons: circularDependency
          ? [`circular dependency detected with ${this.displayPath(normalizedSourcePath)}`]
          : [`depends on ${this.displayPath(normalizedSourcePath)}`],
        distance,
        affectedSymbols: usedSymbols.length > 0 ? usedSymbols : undefined,
        scope: this.classifyScope(normalizedDependentPath, distance, isTestFile),
      });

      if (!circularDependency) {
        await this.propagateImpact(normalizedDependentPath, impactedFiles, distance + 1, visited);
      }
    }

    visited.delete(normalizedSourcePath);
  }

  private analyzeSymbolImpact(
    filePath: string,
    symbolName: string,
    change: ChangeDescriptor,
    impactedFiles: Map<string, ImpactedFile>
  ): SymbolImpact | undefined {
    const sourcePath = this.normalizePath(filePath);
    const sourceNode = this.dependencyGraph.get(sourcePath);
    const symbolExport = sourceNode?.exports.find((item) => item.name === symbolName);
    const references = this.findSymbolReferences(sourcePath, symbolName);
    const rippleFiles = new Set<string>();
    const reasons = new Set<string>();

    if (references.length > 0) {
      reasons.add(`symbol ${symbolName} is referenced by ${references.length} file(s)`);
    }

    const visited = new Set<string>();
    for (const reference of references) {
      rippleFiles.add(reference.filePath);
      this.collectRippleFiles(reference.filePath, visited, rippleFiles, 1);

      this.addImpactedFile(impactedFiles, {
        path: reference.filePath,
        category: reference.isTypeOnly ? 'type-only' : 'transitive',
        severity: reference.isTypeOnly
          ? this.options.includeTypeDependencies ? 'low' : 'none'
          : this.severityForSymbolReference(change.type, reference.distance),
        reasons: [
          `${this.displayPath(reference.filePath)} imports ${symbolName}`,
          reference.isTypeOnly ? `type-only dependency on ${symbolName}` : `symbol usage ripple from ${symbolName}`,
        ],
        distance: Math.max(1, reference.distance),
        affectedSymbols: [symbolName],
        scope: this.classifyScope(reference.filePath, Math.max(1, reference.distance), this.isTestFile(reference.filePath)),
      });
    }

    if (symbolExport?.isTypeOnly) {
      reasons.add(`symbol ${symbolName} is exported as a type-only symbol`);
    }

    const compatibility = this.assessCompatibility(change, symbolExport, references);
    const isBreakingChange = compatibility === 'breaking';
    if (isBreakingChange) {
      reasons.add(`change to ${symbolName} is breaking for downstream consumers`);
    } else if (compatibility === 'potentially-breaking') {
      reasons.add(`change to ${symbolName} may require downstream validation`);
    }

    if (references.length === 0 && !symbolExport) {
      return undefined;
    }

    return {
      symbolName,
      exportedFrom: sourcePath,
      references: references.sort((a, b) => a.distance - b.distance || a.filePath.localeCompare(b.filePath)),
      rippleFiles: Array.from(rippleFiles).sort(),
      directReferenceCount: references.filter((item) => item.distance <= 1).length,
      transitiveReferenceCount: rippleFiles.size,
      isBreakingChange,
      compatibility,
      reasons: Array.from(reasons),
    };
  }

  private findSymbolReferences(filePath: string, symbolName: string): SymbolUsageReference[] {
    const targetPath = this.normalizePath(filePath);
    const results = new Map<string, SymbolUsageReference>();

    for (const [candidatePath, node] of this.dependencyGraph.entries()) {
      for (const imp of node.imports) {
        const resolvedSource = this.resolveImportPath(imp.source, node.path);
        if (resolvedSource !== targetPath) {
          continue;
        }

        const matchesSymbol =
          imp.name === symbolName ||
          imp.localName === symbolName ||
          imp.name === '*' ||
          (imp.kind === 'default' && symbolName === 'default');

        if (!matchesSymbol) {
          continue;
        }

        const existing = results.get(candidatePath);
        const next: SymbolUsageReference = {
          filePath: candidatePath,
          distance: 1,
          importedAs: imp.localName,
          importKind: imp.kind,
          isTypeOnly: imp.isTypeOnly,
        };

        if (!existing || this.referencePriority(next) > this.referencePriority(existing)) {
          results.set(candidatePath, next);
        }
      }
    }

    if (this.symbolIndex) {
      const symbolId = `${targetPath}::${symbolName}`;
      for (const importer of this.symbolIndex.getImporters(symbolId)) {
        const normalizedImporter = this.normalizePath(importer);
        if (!results.has(normalizedImporter)) {
          results.set(normalizedImporter, { filePath: normalizedImporter, distance: 1 });
        }
      }
    }

    return Array.from(results.values());
  }

  private collectRippleFiles(
    sourcePath: string,
    visited: Set<string>,
    rippleFiles: Set<string>,
    distance: number
  ): void {
    const normalized = this.normalizePath(sourcePath);
    if (visited.has(normalized) || distance > this.options.maxDepth) {
      return;
    }

    visited.add(normalized);
    const node = this.dependencyGraph.get(normalized);
    if (!node) {
      return;
    }

    for (const dependent of node.dependents) {
      const normalizedDependent = this.normalizePath(dependent);
      rippleFiles.add(normalizedDependent);
      this.collectRippleFiles(normalizedDependent, visited, rippleFiles, distance + 1);
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
        } else if (imp.kind === 'side-effect') {
          usedSymbols.add('[module-side-effect]');
        } else {
          usedSymbols.add(imp.name);
        }
      }
    }

    return Array.from(usedSymbols).sort();
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
    symbolImpacts: SymbolImpact[]
  ): AffectedTest[] {
    const seenTests = new Map<string, AffectedTest>();

    for (const [path, file] of impactedFiles) {
      if (this.isTestFile(path)) {
        continue;
      }

      const coveringTests = this.findCoveringTests(path, symbolImpacts);
      for (const testPath of coveringTests) {
        const reasons = [
          `${this.displayPath(testPath)} covers ${this.displayPath(path)}`,
        ];
        const existing = seenTests.get(testPath);
        const priority = this.calculateTestPriority(file, testPath);
        const estimatedImpact = this.estimateTestImpact(file, testPath);

        if (existing) {
          existing.coversFiles = Array.from(new Set([...existing.coversFiles, path])).sort();
          existing.priority = this.higherTestPriority(existing.priority, priority);
          existing.estimatedImpact = Math.max(existing.estimatedImpact ?? 0, estimatedImpact);
          existing.reasons = Array.from(new Set([...(existing.reasons ?? []), ...reasons]));
          continue;
        }

        seenTests.set(testPath, {
          path: testPath,
          coversFiles: [path],
          priority,
          scope: this.inferTestScope(testPath),
          estimatedImpact,
          reasons,
        });
      }
    }

    return this.sortTests(Array.from(seenTests.values()));
  }

  private buildTestSelection(affectedTests: AffectedTest[]): TestSelection {
    const byScope: Record<ImpactScope, AffectedTest[]> = {
      unit: [],
      integration: [],
      e2e: [],
    };

    for (const test of affectedTests) {
      byScope[test.scope].push(test);
    }

    const minimal = new Map<string, AffectedTest>();
    const coverageSatisfied = new Set<string>();

    for (const test of this.sortTests(affectedTests)) {
      const missingCoverage = test.coversFiles.some((file) => !coverageSatisfied.has(file));
      if (!missingCoverage) {
        continue;
      }

      minimal.set(test.path, test);
      for (const file of test.coversFiles) {
        coverageSatisfied.add(file);
      }
    }

    return {
      minimal: this.sortTests(Array.from(minimal.values())),
      recommended: this.sortTests(affectedTests),
      byScope: {
        unit: this.sortTests(byScope.unit),
        integration: this.sortTests(byScope.integration),
        e2e: this.sortTests(byScope.e2e),
      },
    };
  }

  private buildRiskAssessment(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[],
    symbolImpacts: SymbolImpact[],
    changes: ChangeDescriptor[]
  ): RiskAssessment {
    const files = Array.from(impactedFiles.values());
    const complexityScore = this.calculateComplexityScore(files, affectedTests, symbolImpacts, changes);
    const criticalPaths = files
      .filter((file) => file.criticalPath)
      .map((file) => file.path)
      .sort();

    const highRiskFiles = files
      .filter((file) => (file.riskScore ?? 0) >= 7 || file.severity === 'critical')
      .map((file) => ({
        path: file.path,
        score: file.riskScore ?? 0,
        reasons: file.reasons,
      }))
      .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

    const score = Math.min(
      100,
      complexityScore * 6 + criticalPaths.length * 8 + highRiskFiles.length * 5 + symbolImpacts.filter((item) => item.isBreakingChange).length * 12
    );

    const level: 'low' | 'medium' | 'high' = score >= 60 ? 'high' : score >= 25 ? 'medium' : 'low';

    return {
      level,
      score,
      complexityScore,
      criticalPaths,
      highRiskFiles,
      mitigationSuggestions: this.generateMitigationSuggestions(level, files, affectedTests, symbolImpacts),
    };
  }

  private calculateSummary(
    impactedFiles: Map<string, ImpactedFile>,
    affectedTests: AffectedTest[],
    symbolImpacts: SymbolImpact[]
  ): ImpactReport['summary'] {
    const files = Array.from(impactedFiles.values());
    const directImpacts = files.filter((f) => f.category === 'direct').length;
    const transitiveImpacts = files.filter((f) => f.category === 'transitive' || f.category === 'type-only').length;
    const testFilesImpacted = new Set([
      ...files.filter((f) => f.category === 'test').map((f) => f.path),
      ...affectedTests.map((f) => f.path),
    ]).size;
    const maxDistance = files.length > 0 ? Math.max(...files.map((f) => f.distance)) : 0;
    const scope = this.maxScope(files.map((file) => file.scope ?? 'unit').concat(affectedTests.map((test) => test.scope)));
    const severity = files.reduce<ImpactSeverity>(
      (current, file) => this.higherSeverity(current, file.severity),
      'none'
    );
    const breakingChanges = symbolImpacts.filter((item) => item.isBreakingChange).length;

    return {
      totalFilesImpacted: files.length,
      directImpacts,
      transitiveImpacts,
      testFilesImpacted,
      maxDistance,
      scope,
      severity,
      breakingChanges,
    };
  }

  private enrichImpactedFiles(
    impactedFiles: Map<string, ImpactedFile>,
    symbolImpacts: SymbolImpact[],
    changes: ChangeDescriptor[]
  ): void {
    const breakingPaths = new Set(
      symbolImpacts.filter((impact) => impact.isBreakingChange).map((impact) => impact.exportedFrom)
    );
    const changedPaths = new Set(changes.map((change) => this.normalizePath(change.path)));

    for (const file of impactedFiles.values()) {
      const riskReasons = new Set<string>(file.reasons);
      let riskScore = 0;

      if (file.distance === 0) riskScore += 4;
      if (file.distance >= 2) riskScore += 1;
      if (file.category === 'dynamic') riskScore += 3;
      if (file.category === 'test') riskScore += 1;
      if (file.category === 'type-only') riskScore -= 1;
      if (file.severity === 'critical') riskScore += 5;
      if (file.severity === 'high') riskScore += 3;
      if (breakingPaths.has(file.path)) {
        riskScore += 4;
        riskReasons.add('breaking public API change');
      }
      if (this.isCriticalPath(file.path)) {
        file.criticalPath = true;
        riskScore += 2;
        riskReasons.add('critical path file');
      }
      if (changedPaths.has(file.path) && this.isTestFile(file.path)) {
        riskReasons.add('directly changed test file');
      }

      file.scope = this.maxScope([file.scope ?? 'unit', this.inferScopeFromReasons(file.reasons)]);
      file.riskScore = Math.max(0, riskScore);
      file.reasons = Array.from(riskReasons);
    }
  }

  private generateRecommendations(
    impactedFiles: Map<string, ImpactedFile>,
    testSelection: TestSelection,
    riskAssessment: RiskAssessment,
    symbolImpacts: SymbolImpact[],
    changes: ChangeDescriptor[]
  ): string[] {
    const recommendations = new Set<string>();
    const files = Array.from(impactedFiles.values());

    if (riskAssessment.level === 'high') {
      recommendations.add('Run the recommended test set and consider a full regression pass before merging');
      recommendations.add('Stage rollout behind a feature flag or deploy incrementally');
    }

    if (testSelection.minimal.length > 0) {
      recommendations.add(`Run minimal test set first (${testSelection.minimal.length} test file(s)) for fast feedback`);
    }

    if (testSelection.byScope.integration.length > 0 || testSelection.byScope.e2e.length > 0) {
      recommendations.add('Include integration or e2e validation because cross-boundary behavior is impacted');
    }

    if (symbolImpacts.some((item) => item.isBreakingChange)) {
      recommendations.add('Review downstream callers for API compatibility before merging');
    }

    if (files.some((f) => f.reasons.some((reason) => reason.includes('circular dependency')))) {
      recommendations.add('Circular dependency detected - review import boundaries before merging');
    }

    if (files.some((f) => f.category === 'dynamic')) {
      recommendations.add('Dynamic or side-effect imports found - add manual validation for runtime wiring');
    }

    if (changes.some((change) => change.type === 'delete' || change.type === 'rename')) {
      recommendations.add('Check external integrations and stale imports because files or symbols moved');
    }

    if (testSelection.recommended.length === 0) {
      recommendations.add('No tests were discovered for the impacted surface - add or map coverage before merging');
    }

    for (const suggestion of riskAssessment.mitigationSuggestions) {
      recommendations.add(suggestion);
    }

    return Array.from(recommendations);
  }

  invalidateCache(paths?: string[]): void {
    if (paths) {
      for (const path of paths) {
        this.dependencyGraph.delete(this.normalizePath(path));
      }
      return;
    }

    this.dependencyGraph.clear();
    this.scannerIndex = null;
  }

  async rebuildGraph(): Promise<void> {
    this.dependencyGraph.clear();

    if (this.repoScanner) {
      const scanResult = await this.repoScanner.scan();
      this.scannerIndex = scanResult.index ?? null;
      this.buildGraphFromScannerIndex(this.scannerIndex);
    }
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

  useSymbolIndex(symbolIndex: SymbolIndex): this {
    this.symbolIndex = symbolIndex;
    return this;
  }

  useRepoScanner(scanner: RepoScanner): this {
    this.repoScanner = scanner;
    this.scannerIndex = scanner.getIndex();
    if (this.scannerIndex) {
      this.buildGraphFromScannerIndex(this.scannerIndex);
    }
    return this;
  }

  private async ensureGraphReady(): Promise<void> {
    if (this.dependencyGraph.size > 0) {
      return;
    }

    if (this.repoScanner) {
      const index = this.repoScanner.getIndex();
      if (index) {
        this.scannerIndex = index;
        this.buildGraphFromScannerIndex(index);
      }
    }
  }

  private buildGraphFromScannerIndex(index?: FileIndex | null): void {
    if (!index) {
      return;
    }

    for (const file of index.files.values()) {
      const normalizedPath = this.normalizePath(file.absolutePath || file.path);
      if (this.dependencyGraph.has(normalizedPath) || this.shouldExclude(normalizedPath)) {
        continue;
      }

      this.dependencyGraph.set(normalizedPath, {
        path: normalizedPath,
        exports: [],
        imports: [],
        dependents: [],
        lastModified: file.modifiedAt,
      });
    }
  }

  private getChangedSymbols(change: ChangeDescriptor, normalizedPath: string): string[] {
    if (change.symbolName) {
      return [change.symbolName];
    }

    const node = this.dependencyGraph.get(normalizedPath);
    if (!node) {
      return [];
    }

    if (change.scope === 'file' && (change.type === 'delete' || change.type === 'rename')) {
      return node.exports.map((entry) => entry.name);
    }

    return [];
  }

  private classifyCategory(
    dependentNode: DependencyNode | undefined,
    isTestFile: boolean,
    usedSymbols: string[]
  ): ImpactCategory {
    if (isTestFile) {
      return 'test';
    }

    if (!dependentNode) {
      return 'transitive';
    }

    if (dependentNode.imports.some((imp) => imp.kind === 'side-effect')) {
      return 'dynamic';
    }

    if (
      usedSymbols.length > 0 &&
      dependentNode.imports
        .filter((imp) => usedSymbols.includes(imp.name) || usedSymbols.includes(imp.localName ?? ''))
        .every((imp) => imp.isTypeOnly)
    ) {
      return 'type-only';
    }

    return 'transitive';
  }

  private severityFromChangeType(type: ChangeType): ImpactSeverity {
    switch (type) {
      case 'delete':
        return 'critical';
      case 'rename':
        return 'high';
      case 'modify':
        return 'high';
      case 'add':
      default:
        return 'medium';
    }
  }

  private calculateTransitiveSeverity(
    distance: number,
    isTest: boolean,
    category: ImpactCategory
  ): ImpactSeverity {
    if (category === 'type-only') {
      return this.options.includeTypeDependencies ? 'low' : 'none';
    }
    if (category === 'dynamic') {
      return 'high';
    }
    if (isTest) {
      return distance <= 1 ? 'medium' : 'low';
    }
    if (distance <= 1) {
      return 'high';
    }
    if (distance <= 3) {
      return 'medium';
    }
    return 'low';
  }

  private severityForSymbolReference(type: ChangeType, distance: number): ImpactSeverity {
    if (type === 'delete') {
      return 'critical';
    }
    if (type === 'rename') {
      return distance <= 1 ? 'critical' : 'high';
    }
    if (distance <= 1) {
      return 'high';
    }
    return 'medium';
  }

  private mergeCategory(a: ImpactCategory, b: ImpactCategory): ImpactCategory {
    const priority: ImpactCategory[] = ['direct', 'dynamic', 'transitive', 'test', 'type-only'];
    const aIndex = priority.indexOf(a);
    const bIndex = priority.indexOf(b);
    return priority[Math.min(aIndex === -1 ? priority.length : aIndex, bIndex === -1 ? priority.length : bIndex)] ?? a;
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

  private findCoveringTests(sourcePath: string, symbolImpacts: SymbolImpact[]): string[] {
    const normalizedSourcePath = this.normalizePath(sourcePath);
    const sourceBase = normalizedSourcePath.replace(/\.[^.]+$/, '');
    const sourceFileName = sourceBase.split('/').pop() ?? sourceBase;
    const tests = new Set<string>();
    const symbolRippleMap = new Map<string, Set<string>>();

    for (const symbolImpact of symbolImpacts) {
      for (const ripplePath of symbolImpact.rippleFiles) {
        const set = symbolRippleMap.get(ripplePath) ?? new Set<string>();
        set.add(symbolImpact.symbolName);
        symbolRippleMap.set(ripplePath, set);
      }
    }

    for (const [candidatePath, node] of this.dependencyGraph.entries()) {
      if (!this.isTestFile(candidatePath)) {
        continue;
      }

      const normalizedCandidate = this.normalizePath(candidatePath);
      const candidateBase = normalizedCandidate.replace(/\.[^.]+$/, '');
      const directlyImportsSource = node.imports.some(
        (imp) => this.resolveImportPath(imp.source, node.path) === normalizedSourcePath
      );
      const nameMatches = candidateBase.includes(sourceFileName);
      const coversRipple = node.imports.some((imp) => symbolRippleMap.has(this.resolveImportPath(imp.source, node.path)));
      const referencesDependent = Array.from(symbolRippleMap.keys()).some((ripplePath) =>
        node.imports.some((imp) => this.resolveImportPath(imp.source, node.path) === ripplePath)
      );

      if (nameMatches || directlyImportsSource || coversRipple || referencesDependent) {
        tests.add(normalizedCandidate);
      }
    }

    return Array.from(tests).sort();
  }

  private calculateTestPriority(file: ImpactedFile, testPath: string): TestPriority {
    const scope = this.inferTestScope(testPath);
    if (scope === 'e2e' && (file.severity === 'critical' || file.scope === 'e2e')) {
      return 'critical';
    }
    if (file.severity === 'critical') {
      return 'critical';
    }
    if (file.severity === 'high' || file.distance <= 1 || scope === 'integration') {
      return 'high';
    }
    return 'normal';
  }

  private estimateTestImpact(file: ImpactedFile, testPath: string): number {
    const scopeWeight = this.inferTestScope(testPath) === 'e2e' ? 3 : this.inferTestScope(testPath) === 'integration' ? 2 : 1;
    return (file.riskScore ?? 0) + scopeWeight + Math.max(0, 4 - file.distance);
  }

  private higherTestPriority(
    a: TestPriority,
    b: TestPriority
  ): TestPriority {
    const order: TestPriority[] = ['critical', 'high', 'normal'];
    return order[Math.min(order.indexOf(a), order.indexOf(b))] ?? a;
  }

  private inferTestScope(testPath: string): ImpactScope {
    const lower = testPath.toLowerCase();
    if (lower.includes('e2e') || lower.includes('end-to-end')) {
      return 'e2e';
    }
    if (lower.includes('integration') || lower.includes('__integration__')) {
      return 'integration';
    }
    return 'unit';
  }

  private classifyScope(path: string, distance: number, isTestFile: boolean): ImpactScope {
    if (isTestFile) {
      return this.inferTestScope(path);
    }

    const lower = path.toLowerCase();
    if (
      distance >= 2 ||
      lower.includes('/api/') ||
      lower.includes('/router') ||
      lower.includes('/runtime') ||
      lower.includes('/integration')
    ) {
      return 'integration';
    }

    if (
      lower.includes('/cli/') ||
      lower.includes('/session') ||
      lower.includes('/executor') ||
      lower.includes('/telemetry')
    ) {
      return 'e2e';
    }

    return 'unit';
  }

  private inferScopeFromReasons(reasons: string[]): ImpactScope {
    const text = reasons.join(' ').toLowerCase();
    if (text.includes('e2e')) return 'e2e';
    if (text.includes('integration') || text.includes('depends on')) return 'integration';
    return 'unit';
  }

  private calculateComplexityScore(
    files: ImpactedFile[],
    affectedTests: AffectedTest[],
    symbolImpacts: SymbolImpact[],
    changes: ChangeDescriptor[]
  ): number {
    return (
      changes.length +
      files.filter((file) => file.distance === 0).length * 2 +
      files.filter((file) => file.distance > 0).length +
      affectedTests.length +
      symbolImpacts.filter((item) => item.isBreakingChange).length * 3 +
      symbolImpacts.reduce((sum, item) => sum + item.references.length, 0)
    );
  }

  private generateMitigationSuggestions(
    level: 'low' | 'medium' | 'high',
    files: ImpactedFile[],
    affectedTests: AffectedTest[],
    symbolImpacts: SymbolImpact[]
  ): string[] {
    const suggestions = new Set<string>();

    if (affectedTests.length > 0) {
      suggestions.add('Start with unit tests, then widen to integration/e2e only if failures or contract changes appear');
    }

    if (files.some((file) => file.category === 'dynamic')) {
      suggestions.add('Manually verify startup/runtime flows because side-effect imports can bypass static analysis');
    }

    if (symbolImpacts.some((impact) => impact.compatibility !== 'backward-compatible')) {
      suggestions.add('Update or validate API consumers and release notes for externally visible behavior changes');
    }

    if (files.some((file) => (file.riskScore ?? 0) >= 7)) {
      suggestions.add('Request targeted review on the highest-risk files before merge');
    }

    if (level === 'high') {
      suggestions.add('Prefer smaller follow-up commits or phased rollout to reduce blast radius');
    }

    return Array.from(suggestions);
  }

  private assessCompatibility(
    change: ChangeDescriptor,
    symbolExport: DependencyNode['exports'][number] | undefined,
    references: SymbolUsageReference[]
  ): SymbolImpact['compatibility'] {
    if (change.type === 'delete') {
      return references.length > 0 ? 'breaking' : 'potentially-breaking';
    }
    if (change.type === 'rename') {
      return references.length > 0 ? 'breaking' : 'potentially-breaking';
    }
    if (change.type === 'modify') {
      if (references.length === 0) {
        return 'backward-compatible';
      }
      if (symbolExport?.isTypeOnly) {
        return this.options.includeTypeDependencies ? 'potentially-breaking' : 'backward-compatible';
      }
      return 'potentially-breaking';
    }
    return 'backward-compatible';
  }

  private isCriticalPath(path: string): boolean {
    const lower = path.toLowerCase();
    return [
      '/router',
      '/runtime',
      '/executor',
      '/session',
      '/repairer',
      '/reviewer',
      '/integration',
      '/cli/',
    ].some((segment) => lower.includes(segment));
  }

  private maxScope(scopes: ImpactScope[]): ImpactScope {
    const order: ImpactScope[] = ['unit', 'integration', 'e2e'];
    return scopes.reduce((current, scope) => {
      return order.indexOf(scope) > order.indexOf(current) ? scope : current;
    }, 'unit');
  }

  private sortImpactedFiles(files: ImpactedFile[]): ImpactedFile[] {
    return files.sort(
      (a, b) =>
        this.severityRank(a.severity) - this.severityRank(b.severity) ||
        (b.riskScore ?? 0) - (a.riskScore ?? 0) ||
        a.distance - b.distance ||
        a.path.localeCompare(b.path)
    );
  }

  private sortTests(tests: AffectedTest[]): AffectedTest[] {
    return [...tests].sort(
      (a, b) =>
        this.testPriorityRank(a.priority) - this.testPriorityRank(b.priority) ||
        this.scopeRank(b.scope) - this.scopeRank(a.scope) ||
        (b.estimatedImpact ?? 0) - (a.estimatedImpact ?? 0) ||
        a.path.localeCompare(b.path)
    );
  }

  private addImpactedFile(
    impactedFiles: Map<string, ImpactedFile>,
    file: ImpactedFile
  ): void {
    if (file.severity === 'none' && !this.options.includeTypeDependencies) {
      return;
    }

    const normalizedPath = this.normalizePath(file.path);
    const nextFile = { ...file, path: normalizedPath };
    const existing = impactedFiles.get(normalizedPath);

    if (existing) {
      existing.category = this.mergeCategory(existing.category, nextFile.category);
      existing.severity = this.higherSeverity(existing.severity, nextFile.severity);
      existing.reasons = [...new Set([...existing.reasons, ...nextFile.reasons])];
      existing.distance = Math.min(existing.distance, nextFile.distance);
      existing.scope = this.maxScope([existing.scope ?? 'unit', nextFile.scope ?? 'unit']);
      existing.criticalPath = existing.criticalPath || nextFile.criticalPath;
      existing.riskScore = Math.max(existing.riskScore ?? 0, nextFile.riskScore ?? 0);
      if (nextFile.affectedSymbols) {
        existing.affectedSymbols = [
          ...new Set([...(existing.affectedSymbols || []), ...nextFile.affectedSymbols]),
        ].sort();
      }
      return;
    }

    impactedFiles.set(normalizedPath, nextFile);
  }

  private shouldExclude(filePath: string): boolean {
    return this.options.excludePatterns.some((pattern) => this.matchPattern(filePath, pattern));
  }

  private referencePriority(reference: SymbolUsageReference): number {
    return (reference.isTypeOnly ? 0 : 10) + (reference.importKind === 'namespace' ? 1 : 0);
  }

  private testPriorityRank(priority: TestPriority): number {
    return ['critical', 'high', 'normal'].indexOf(priority);
  }

  private scopeRank(scope: ImpactScope): number {
    return ['unit', 'integration', 'e2e'].indexOf(scope);
  }

  private compatibilityRank(compatibility: SymbolImpact['compatibility']): number {
    return ['breaking', 'potentially-breaking', 'backward-compatible'].indexOf(compatibility);
  }

  private normalizePath(filePath: string): string {
    const rootDir = this.options.rootDir ? resolve(this.options.rootDir) : process.cwd();
    const absoluteCandidate = filePath.startsWith('/') ? filePath : resolve(rootDir, filePath);
    return normalize(absoluteCandidate).replace(/\\/g, '/');
  }

  private displayPath(filePath: string): string {
    const rootDir = this.options.rootDir ? resolve(this.options.rootDir) : process.cwd();
    const normalized = this.normalizePath(filePath);
    const relativePath = relative(rootDir, normalized).replace(/\\/g, '/');
    return relativePath && !relativePath.startsWith('..') ? relativePath : normalized;
  }

  private matchPattern(value: string, pattern: string): boolean {
    const normalizedValue = this.normalizePath(value);
    const relativeValue = this.displayPath(normalizedValue);
    const escapedPattern = this.normalizePath(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
    const regexPattern = escapedPattern
      .replace(/\*\*/g, '::GLOBSTAR::')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.')
      .replace(/::GLOBSTAR::/g, '.*');

    const regex = new RegExp(`^${regexPattern}$`);
    return regex.test(normalizedValue) || regex.test(relativeValue);
  }
}

export function createImpactAnalyzer(options?: Partial<ImpactAnalyzerOptions>): ImpactAnalyzer {
  return new ImpactAnalyzer(options);
}

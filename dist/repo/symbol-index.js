// Symbol Import Index
// Thread 06: symbol-import-index
// Provides bi-directional mapping between symbols and their imports/exports
import * as ts from 'typescript';
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, normalize, relative, resolve } from 'path';
function makeSymbolId(filePath, name) {
    return `${normalize(filePath)}::${name}`;
}
function hashContent(content) {
    return createHash('md5').update(content).digest('hex');
}
const DEFAULT_CONFIG = {
    include: ['.ts', '.tsx', '.js', '.jsx'],
    exclude: ['node_modules', 'dist', 'build', '.git'],
    pathAliases: {},
};
export class SymbolIndex {
    definitions = new Map();
    fileIndex = new Map();
    fileToSymbols = new Map();
    reverseImports = new Map();
    config;
    errors = [];
    constructor(config) {
        this.config = {
            rootDir: normalize(resolve(config.rootDir)),
            include: config.include ?? DEFAULT_CONFIG.include,
            exclude: config.exclude ?? DEFAULT_CONFIG.exclude,
            pathAliases: config.pathAliases ?? DEFAULT_CONFIG.pathAliases,
            tsConfigPath: config.tsConfigPath,
        };
    }
    async build(filePaths) {
        this.errors = [];
        let processed = 0;
        for (const filePath of filePaths) {
            if (!this.shouldIncludeFile(filePath)) {
                continue;
            }
            await this.indexFile(filePath);
            processed += 1;
        }
        return {
            success: this.errors.length === 0,
            errors: [...this.errors],
            filesProcessed: processed,
            symbolsIndexed: this.definitions.size,
        };
    }
    async updateFile(filePath) {
        this.removeFile(filePath);
        if (this.shouldIncludeFile(filePath)) {
            await this.indexFile(filePath);
        }
    }
    removeFile(filePath) {
        const normalizedFilePath = normalize(resolve(filePath));
        const entry = this.fileIndex.get(normalizedFilePath);
        if (!entry)
            return;
        for (const symbolId of entry.definedSymbols) {
            this.definitions.delete(symbolId);
            this.reverseImports.delete(symbolId);
        }
        for (const symbolImporters of this.reverseImports.values()) {
            symbolImporters.delete(normalizedFilePath);
        }
        this.fileIndex.delete(normalizedFilePath);
        this.fileToSymbols.delete(normalizedFilePath);
    }
    resolveSymbol(name, fromFile) {
        const normalizedFromFile = normalize(resolve(fromFile));
        const localSymbols = this.fileToSymbols.get(normalizedFromFile);
        if (localSymbols) {
            for (const symbolId of localSymbols) {
                const def = this.definitions.get(symbolId);
                if (def?.name === name)
                    return def;
            }
        }
        const entry = this.fileIndex.get(normalizedFromFile);
        if (!entry) {
            return null;
        }
        for (const imp of entry.imports) {
            if (imp.localName !== name || !imp.resolvedPath) {
                continue;
            }
            if (imp.isNamespace) {
                const namespaceSymbols = this.fileToSymbols.get(imp.resolvedPath);
                if (!namespaceSymbols)
                    continue;
                for (const symbolId of namespaceSymbols) {
                    const def = this.definitions.get(symbolId);
                    if (def?.name === name)
                        return def;
                }
                continue;
            }
            const symbolId = makeSymbolId(imp.resolvedPath, imp.importedName);
            return this.definitions.get(symbolId) ?? null;
        }
        return null;
    }
    getImports(filePath) {
        return this.fileIndex.get(normalize(resolve(filePath)))?.imports ?? [];
    }
    getImporters(symbolId) {
        return Array.from(this.reverseImports.get(symbolId) ?? []);
    }
    getSymbolsInFile(filePath) {
        return Array.from(this.fileToSymbols.get(normalize(resolve(filePath))) ?? []);
    }
    getDefinition(symbolId) {
        return this.definitions.get(symbolId);
    }
    shouldIncludeFile(filePath) {
        const normalizedPath = normalize(resolve(filePath));
        const relativePath = relative(this.config.rootDir, normalizedPath);
        if (relativePath.startsWith('..') || relativePath === '') {
            return false;
        }
        const ext = normalizedPath.slice(normalizedPath.lastIndexOf('.'));
        if (!this.config.include.includes(ext))
            return false;
        return !this.config.exclude.some((pattern) => relativePath.includes(pattern));
    }
    async indexFile(filePath) {
        const normalizedPath = normalize(resolve(filePath));
        try {
            const content = readFileSync(normalizedPath, 'utf-8');
            const contentHash = hashContent(content);
            const existing = this.fileIndex.get(normalizedPath);
            if (existing?.contentHash === contentHash)
                return;
            const sourceFile = ts.createSourceFile(normalizedPath, content, ts.ScriptTarget.Latest, true);
            const imports = [];
            const exports = [];
            const definedSymbols = new Set();
            ts.forEachChild(sourceFile, (node) => {
                if (ts.isImportDeclaration(node)) {
                    imports.push(...this.parseImport(node, normalizedPath, sourceFile));
                }
                if (this.isExport(node)) {
                    const parsedExports = this.parseExport(node, normalizedPath, sourceFile);
                    exports.push(...parsedExports);
                    for (const entry of parsedExports) {
                        if (!entry.reExportedFrom || this.definitions.has(entry.symbolId)) {
                            definedSymbols.add(entry.symbolId);
                        }
                    }
                }
            });
            this.fileIndex.set(normalizedPath, {
                filePath: normalizedPath,
                contentHash,
                imports,
                exports,
                definedSymbols: Array.from(definedSymbols),
            });
            this.fileToSymbols.set(normalizedPath, new Set(definedSymbols));
            for (const imp of imports) {
                if (!imp.resolvedPath || imp.isNamespace) {
                    continue;
                }
                const targetSymbolId = makeSymbolId(imp.resolvedPath, imp.importedName);
                if (!this.reverseImports.has(targetSymbolId)) {
                    this.reverseImports.set(targetSymbolId, new Set());
                }
                this.reverseImports.get(targetSymbolId)?.add(normalizedPath);
            }
        }
        catch (err) {
            this.errors.push({
                filePath: normalizedPath,
                message: err instanceof Error ? err.message : String(err),
            });
        }
    }
    parseImport(node, filePath, sourceFile) {
        const entries = [];
        const sourcePath = this.getModuleSpecifier(node.moduleSpecifier, sourceFile);
        const resolvedPath = this.resolveImportPath(sourcePath, filePath);
        const location = this.getNodeLocation(node, sourceFile);
        if (node.importClause?.name) {
            const localName = node.importClause.name.getText(sourceFile);
            entries.push({
                localName,
                importedName: 'default',
                sourcePath,
                resolvedPath,
                isDefault: true,
                isNamespace: false,
                location,
            });
        }
        const bindings = node.importClause?.namedBindings;
        if (bindings && ts.isNamedImports(bindings)) {
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
                    location,
                });
            }
        }
        if (bindings && ts.isNamespaceImport(bindings)) {
            const localName = bindings.name.getText(sourceFile);
            entries.push({
                localName,
                importedName: '*',
                sourcePath,
                resolvedPath,
                isDefault: false,
                isNamespace: true,
                location,
            });
        }
        return entries;
    }
    isExport(node) {
        if (ts.isExportDeclaration(node) || ts.isExportAssignment(node))
            return true;
        if (ts.isVariableStatement(node) ||
            ts.isFunctionDeclaration(node) ||
            ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isTypeAliasDeclaration(node)) {
            return this.hasExportModifier(node);
        }
        return false;
    }
    parseExport(node, filePath, sourceFile) {
        const entries = [];
        if (ts.isExportDeclaration(node)) {
            const moduleSpecifier = node.moduleSpecifier
                ? this.getModuleSpecifier(node.moduleSpecifier, sourceFile)
                : undefined;
            const resolvedPath = moduleSpecifier
                ? this.resolveImportPath(moduleSpecifier, filePath)
                : undefined;
            if (node.exportClause && ts.isNamedExports(node.exportClause)) {
                for (const element of node.exportClause.elements) {
                    const exportedName = element.name.getText(sourceFile);
                    const sourceName = element.propertyName?.getText(sourceFile) ?? exportedName;
                    if (moduleSpecifier) {
                        const symbolId = makeSymbolId(resolvedPath ?? filePath, sourceName);
                        entries.push({ symbolId, reExportedFrom: moduleSpecifier });
                    }
                    else {
                        const symbolId = makeSymbolId(filePath, sourceName);
                        const existing = this.definitions.get(symbolId);
                        if (existing) {
                            existing.isNamed = true;
                            entries.push({ symbolId });
                        }
                    }
                }
            }
            return entries;
        }
        if (ts.isFunctionDeclaration(node) && node.name) {
            entries.push({ symbolId: this.storeDefinition(filePath, node.name.getText(sourceFile), 'function', node, sourceFile) });
            return entries;
        }
        if (ts.isVariableStatement(node)) {
            for (const decl of node.declarationList.declarations) {
                if (!ts.isIdentifier(decl.name))
                    continue;
                const kind = this.inferSymbolKind(node, decl);
                entries.push({ symbolId: this.storeDefinition(filePath, decl.name.getText(sourceFile), kind, decl.name, sourceFile) });
            }
            return entries;
        }
        if ((ts.isClassDeclaration(node) ||
            ts.isInterfaceDeclaration(node) ||
            ts.isEnumDeclaration(node) ||
            ts.isTypeAliasDeclaration(node)) &&
            node.name) {
            entries.push({ symbolId: this.storeDefinition(filePath, node.name.getText(sourceFile), this.getKindFromNode(node), node.name, sourceFile) });
            return entries;
        }
        if (ts.isExportAssignment(node)) {
            const exportedName = ts.isIdentifier(node.expression)
                ? node.expression.text
                : 'default';
            const symbolId = makeSymbolId(filePath, exportedName);
            const existing = this.definitions.get(symbolId);
            if (existing) {
                existing.isDefault = true;
                entries.push({ symbolId });
            }
            else {
                entries.push({ symbolId: this.storeDefinition(filePath, exportedName, 'const', node, sourceFile, true) });
            }
        }
        return entries;
    }
    storeDefinition(filePath, name, kind, node, sourceFile, isDefault = false) {
        const symbolId = makeSymbolId(filePath, name);
        this.definitions.set(symbolId, {
            id: symbolId,
            name,
            kind,
            location: this.getNodeLocation(node, sourceFile),
            isDefault,
            isNamed: !isDefault,
        });
        return symbolId;
    }
    hasExportModifier(node) {
        return ts.canHaveModifiers(node)
            ? (ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)
            : false;
    }
    inferSymbolKind(stmt, decl) {
        if (decl.initializer && (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))) {
            return 'function';
        }
        if (stmt.declarationList.flags & ts.NodeFlags.Const)
            return 'const';
        if (stmt.declarationList.flags & ts.NodeFlags.Let)
            return 'let';
        return 'var';
    }
    getKindFromNode(node) {
        if (ts.isClassDeclaration(node))
            return 'class';
        if (ts.isInterfaceDeclaration(node))
            return 'interface';
        if (ts.isEnumDeclaration(node))
            return 'enum';
        if (ts.isTypeAliasDeclaration(node))
            return 'type';
        return 'const';
    }
    resolveImportPath(importPath, fromFile) {
        if (!importPath)
            return undefined;
        if (!importPath.startsWith('.') && !this.matchesAlias(importPath)) {
            return `npm:${importPath}`;
        }
        const candidateBases = [];
        for (const [alias, targets] of Object.entries(this.config.pathAliases)) {
            const aliasPrefix = alias.replace(/\*.*$/, '');
            if (!importPath.startsWith(aliasPrefix))
                continue;
            const remainder = importPath.slice(aliasPrefix.length).replace(/^\//, '');
            for (const target of targets) {
                const targetPrefix = target.replace(/\*.*$/, '');
                candidateBases.push(resolve(this.config.rootDir, targetPrefix, remainder));
            }
        }
        if (importPath.startsWith('.')) {
            candidateBases.push(resolve(dirname(fromFile), importPath));
        }
        for (const basePath of candidateBases) {
            const safePath = normalize(basePath);
            const relativeToRoot = relative(this.config.rootDir, safePath);
            if (relativeToRoot.startsWith('..')) {
                continue;
            }
            const resolved = this.resolveExistingModulePath(safePath);
            if (resolved) {
                return resolved;
            }
        }
        return undefined;
    }
    matchesAlias(importPath) {
        return Object.keys(this.config.pathAliases).some((alias) => importPath.startsWith(alias.replace(/\*.*$/, '')));
    }
    resolveExistingModulePath(basePath) {
        if (existsSync(basePath)) {
            return normalize(basePath);
        }
        for (const ext of this.config.include) {
            const withExt = `${basePath}${ext}`;
            if (existsSync(withExt))
                return normalize(withExt);
        }
        for (const ext of this.config.include) {
            const indexPath = join(basePath, `index${ext}`);
            if (existsSync(indexPath))
                return normalize(indexPath);
        }
        return undefined;
    }
    getModuleSpecifier(node, sourceFile) {
        if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
            return node.text;
        }
        return node.getText(sourceFile).slice(1, -1);
    }
    getNodeLocation(node, sourceFile) {
        const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const length = Math.max(1, node.getWidth(sourceFile));
        return {
            filePath: sourceFile.fileName,
            line: start.line + 1,
            column: start.character + 1,
            length,
        };
    }
    toJSON() {
        return {
            config: this.config,
            definitions: Object.fromEntries(this.definitions),
            fileIndex: Object.fromEntries(this.fileIndex),
            reverseImports: Object.fromEntries(Array.from(this.reverseImports.entries()).map(([key, value]) => [key, Array.from(value)])),
        };
    }
    static fromJSON(data) {
        const typed = data;
        const index = new SymbolIndex(typed.config ?? {
            rootDir: process.cwd(),
            include: DEFAULT_CONFIG.include,
            exclude: DEFAULT_CONFIG.exclude,
            pathAliases: DEFAULT_CONFIG.pathAliases,
        });
        if (typed.definitions) {
            index.definitions = new Map(Object.entries(typed.definitions));
        }
        if (typed.fileIndex) {
            index.fileIndex = new Map(Object.entries(typed.fileIndex));
            for (const [filePath, entry] of index.fileIndex.entries()) {
                index.fileToSymbols.set(filePath, new Set(entry.definedSymbols));
            }
        }
        if (typed.reverseImports) {
            index.reverseImports = new Map(Object.entries(typed.reverseImports).map(([key, value]) => [key, new Set(value)]));
        }
        return index;
    }
}
export async function buildSymbolIndex(filePaths, config) {
    const index = new SymbolIndex(config);
    const result = await index.build(filePaths);
    return { index, result };
}

/**
 * Impact Analyzer Types
 * Defines the contract for analyzing code change impact.
 */
/**
 * Default analyzer options
 */
export const DEFAULT_ANALYZER_OPTIONS = {
    maxDepth: 10,
    includeTests: true,
    includeTypeDependencies: true,
    excludePatterns: ['node_modules/**', 'dist/**', 'build/**', '.git/**'],
    testPatterns: ['**/*.test.ts', '**/*.spec.ts', '**/__tests__/**', '**/*.test.js', '**/*.spec.js'],
    rootDir: process.cwd(),
};

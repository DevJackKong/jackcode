/**
 * Thread 20: Integration QA Types
 * Type definitions for integration testing and quality assurance
 */
/**
 * Default smoke test configuration
 */
export const DEFAULT_SMOKE_CONFIG = {
    parallel: true,
    maxConcurrency: 4,
    defaultTimeoutMs: 30000,
    failFast: false,
    retries: 2,
};
/**
 * Standard release criteria
 */
export const STANDARD_RELEASE_CRITERIA = {
    P0: {
        level: 'P0',
        minSmokePassRate: 1.0,
        minIntegrationCoverage: 0.8,
        maxCriticalBugs: 0,
        maxHighBugs: 0,
        minUnitCoverage: 0.8,
        performanceRequired: true,
    },
    P1: {
        level: 'P1',
        minSmokePassRate: 0.95,
        minIntegrationCoverage: 0.7,
        maxCriticalBugs: 0,
        maxHighBugs: 3,
        minUnitCoverage: 0.7,
        performanceRequired: true,
    },
    P2: {
        level: 'P2',
        minSmokePassRate: 0.9,
        minIntegrationCoverage: 0.6,
        maxCriticalBugs: 1,
        maxHighBugs: 5,
        minUnitCoverage: 0.6,
        performanceRequired: false,
    },
};
/**
 * Thread pairs that must be tested (P0 priority)
 */
export const P0_THREAD_PAIRS = [
    { from: 'thread-01', to: 'thread-02' }, // Runtime → Session
    { from: 'thread-01', to: 'thread-09' }, // Runtime → Qwen
    { from: 'thread-01', to: 'thread-10' }, // Runtime → legacy repair path
    { from: 'thread-01', to: 'thread-11' }, // Runtime → GPT-5.4
    { from: 'thread-03', to: 'thread-04' }, // Patch → Build-Test
    { from: 'thread-04', to: 'thread-11' }, // Build-Test → GPT-5.4
    { from: 'thread-13', to: 'thread-01' }, // JackClaw Node → Runtime
];
/**
 * E2E flow test definitions
 */
export const E2E_FLOW_TESTS = [
    {
        id: 'flow-01',
        name: 'Happy Path',
        description: 'Complete successful task lifecycle',
        stateSequence: ['planning', 'executing', 'reviewing', 'completed'],
        requiredThreads: ['thread-01', 'thread-09', 'thread-11'],
        successCriteria: 'Task completes without errors',
    },
    {
        id: 'flow-02',
        name: 'Repair Loop',
        description: 'Execute failure and recovery',
        stateSequence: ['planning', 'executing', 'retrying', 'executing', 'reviewing', 'completed'],
        requiredThreads: ['thread-01', 'thread-09', 'thread-10', 'thread-11'],
        successCriteria: 'Repair successfully resolves failure',
    },
    {
        id: 'flow-03',
        name: 'Max Attempts',
        description: 'Exhaust retry budget',
        stateSequence: ['planning', 'executing', 'retrying', 'executing', 'retrying', 'executing', 'error'],
        requiredThreads: ['thread-01', 'thread-09', 'thread-10'],
        successCriteria: 'Task transitions to error after max attempts',
    },
];

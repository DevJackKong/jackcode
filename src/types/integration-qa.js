/**
 * Runtime constants shim for Integration QA.
 * Keeps Node's direct TypeScript execution happy in environments without a TS build step.
 */

export const DEFAULT_SMOKE_CONFIG = {
  parallel: true,
  maxConcurrency: 4,
  defaultTimeoutMs: 30000,
  failFast: false,
  retries: 2,
};

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

export const P0_THREAD_PAIRS = [
  { from: 'thread-01', to: 'thread-02' },
  { from: 'thread-01', to: 'thread-09' },
  { from: 'thread-01', to: 'thread-10' },
  { from: 'thread-01', to: 'thread-11' },
  { from: 'thread-03', to: 'thread-04' },
  { from: 'thread-04', to: 'thread-11' },
  { from: 'thread-13', to: 'thread-01' },
];

export const E2E_FLOW_TESTS = [
  {
    id: 'flow-01',
    name: 'Happy Path',
    description: 'Complete successful task lifecycle',
    stateSequence: ['plan', 'execute', 'review', 'done'],
    requiredThreads: ['thread-01', 'thread-09', 'thread-11'],
    successCriteria: 'Task completes without errors',
  },
  {
    id: 'flow-02',
    name: 'Repair Loop',
    description: 'Execute failure and recovery',
    stateSequence: ['plan', 'execute', 'repair', 'execute', 'review', 'done'],
    requiredThreads: ['thread-01', 'thread-09', 'thread-10', 'thread-11'],
    successCriteria: 'Repair successfully resolves failure',
  },
  {
    id: 'flow-03',
    name: 'Max Attempts',
    description: 'Exhaust retry budget',
    stateSequence: ['plan', 'execute', 'repair', 'execute', 'repair', 'execute', 'error'],
    requiredThreads: ['thread-01', 'thread-09', 'thread-10'],
    successCriteria: 'Task transitions to error after max attempts',
  },
];

/**
 * Thread 20: Integration QA Types
 * Type definitions for integration testing and quality assurance
 */

import type { TaskContext, TaskState } from '../core/runtime.js';

/**
 * Test priority levels
 */
export type TestPriority = 'P0' | 'P1' | 'P2';

/**
 * Test execution status
 */
export type TestStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';

/**
 * Thread identifier (matches master plan numbering)
 */
export type ThreadId =
  | 'thread-01'
  | 'thread-02'
  | 'thread-03'
  | 'thread-04'
  | 'thread-05'
  | 'thread-06'
  | 'thread-07'
  | 'thread-08'
  | 'thread-09'
  | 'thread-10'
  | 'thread-11'
  | 'thread-12'
  | 'thread-13'
  | 'thread-14'
  | 'thread-15'
  | 'thread-16'
  | 'thread-17'
  | 'thread-18'
  | 'thread-19'
  | 'thread-20';

/**
 * Thread pair identifier
 */
export interface ThreadPair {
  from: ThreadId;
  to: ThreadId;
}

/**
 * Integration test definition
 */
export interface IntegrationTest {
  /** Unique test identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Test description */
  description: string;
  /** Threads involved */
  threads: ThreadId[];
  /** Test priority */
  priority: TestPriority;
  /** Test scenario */
  scenario: string;
  /** Setup function name */
  setup?: string;
  /** Verification steps */
  steps: TestStep[];
  /** Cleanup function name */
  teardown?: string;
  /** Timeout in ms */
  timeoutMs: number;
}

/**
 * Single test step
 */
export interface TestStep {
  /** Step number */
  order: number;
  /** Action description */
  action: string;
  /** Verification criteria */
  verification: string;
  /** Optional expected error */
  expectError?: boolean;
}

/**
 * Test execution result
 */
export interface TestResult {
  /** Test ID */
  testId: string;
  /** Final status */
  status: TestStatus;
  /** Start timestamp */
  startedAt: number;
  /** End timestamp */
  endedAt: number;
  /** Duration in ms */
  durationMs: number;
  /** Step results */
  stepResults: StepResult[];
  /** Error details if failed */
  error?: TestError;
  /** Console output */
  logs: string[];
}

/**
 * Individual step result
 */
export interface StepResult {
  /** Step number */
  step: number;
  /** Step passed */
  passed: boolean;
  /** Duration in ms */
  durationMs: number;
  /** Error if failed */
  error?: string;
}

/**
 * Test error details
 */
export interface TestError {
  /** Error message */
  message: string;
  /** Stack trace */
  stack?: string;
  /** Related thread */
  thread?: ThreadId;
  /** Recovery suggestion */
  suggestion?: string;
}

/**
 * QA Matrix dimension
 */
export interface QADimension {
  /** Dimension name */
  name: string;
  /** Test scope */
  scope: string;
  /** Pass criteria */
  criteria: string;
  /** Current status */
  status: 'not-started' | 'in-progress' | 'passed' | 'failed';
  /** Coverage percentage */
  coverage: number;
}

/**
 * QA Matrix report
 */
export interface QAMatrix {
  /** Generation timestamp */
  generatedAt: number;
  /** QA dimensions */
  dimensions: QADimension[];
  /** Thread pair coverage */
  pairCoverage: ThreadPairCoverage[];
  /** Overall score (0-1) */
  overallScore: number;
  /** Release readiness */
  releaseReady: boolean;
}

/**
 * Thread pair test coverage
 */
export interface ThreadPairCoverage {
  /** Thread pair */
  pair: ThreadPair;
  /** Tests defined */
  totalTests: number;
  /** Tests passing */
  passingTests: number;
  /** Coverage percentage */
  coverage: number;
  /** Last tested */
  lastTested?: number;
}

/**
 * Release criteria levels
 */
export type ReleaseCriteriaLevel = 'P0' | 'P1' | 'P2';

/**
 * Release criteria configuration
 */
export interface ReleaseCriteria {
  /** Criteria level */
  level: ReleaseCriteriaLevel;
  /** Required smoke test pass rate (0-1) */
  minSmokePassRate: number;
  /** Required integration coverage (0-1) */
  minIntegrationCoverage: number;
  /** Max allowed critical bugs */
  maxCriticalBugs: number;
  /** Max allowed high bugs */
  maxHighBugs: number;
  /** Required unit test coverage (0-1) */
  minUnitCoverage: number;
  /** Performance benchmark requirement */
  performanceRequired: boolean;
}

/**
 * Release validation result
 */
export interface ReleaseValidation {
  /** Validation timestamp */
  validatedAt: number;
  /** Criteria used */
  criteria: ReleaseCriteria;
  /** Individual checks */
  checks: ReleaseCheck[];
  /** Overall result */
  passed: boolean;
  /** Blockers if failed */
  blockers: string[];
  /** Warnings */
  warnings: string[];
}

/**
 * Individual release check
 */
export interface ReleaseCheck {
  /** Check name */
  name: string;
  /** Check category */
  category: 'functional' | 'integration' | 'performance' | 'quality';
  /** Check passed */
  passed: boolean;
  /** Details */
  details: string;
  /** Severity if failed */
  severity?: 'critical' | 'high' | 'medium';
}

/**
 * End-to-end flow test definition
 */
export interface E2EFlowTest {
  /** Flow ID */
  id: string;
  /** Flow name */
  name: string;
  /** Flow description */
  description: string;
  /** Sequence of states */
  stateSequence: TaskState[];
  /** Required threads */
  requiredThreads: ThreadId[];
  /** Success criteria */
  successCriteria: string;
  /** Mock data needed */
  mockData?: Record<string, unknown>;
}

/**
 * Smoke test suite configuration
 */
export interface SmokeTestConfig {
  /** Parallel execution */
  parallel: boolean;
  /** Max concurrency */
  maxConcurrency: number;
  /** Test timeout in ms */
  defaultTimeoutMs: number;
  /** Stop on first failure */
  failFast: boolean;
  /** Retry count for flaky tests */
  retries: number;
}

/**
 * Integration registry entry
 */
export interface IntegrationRegistryEntry {
  /** Thread ID */
  threadId: ThreadId;
  /** Provided interfaces */
  provides: string[];
  /** Required interfaces */
  requires: string[];
  /** Integration points */
  integrationPoints: IntegrationPoint[];
}

/**
 * Integration point definition
 */
export interface IntegrationPoint {
  /** Point name */
  name: string;
  /** Interface contract */
  contract: string;
  /** Handler function reference */
  handler: string;
  /** Async or sync */
  async: boolean;
}

/**
 * Default smoke test configuration
 */
export const DEFAULT_SMOKE_CONFIG: SmokeTestConfig = {
  parallel: true,
  maxConcurrency: 4,
  defaultTimeoutMs: 30000,
  failFast: false,
  retries: 2,
};

/**
 * Standard release criteria
 */
export const STANDARD_RELEASE_CRITERIA: Record<ReleaseCriteriaLevel, ReleaseCriteria> = {
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
export const P0_THREAD_PAIRS: ThreadPair[] = [
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
export const E2E_FLOW_TESTS: E2EFlowTest[] = [
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

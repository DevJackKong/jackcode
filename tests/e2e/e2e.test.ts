import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runAllE2EScenarios,
  runErrorRecoveryScenario,
  runRefactoringScenario,
  runSimpleModificationScenario,
  runTddScenario,
  cleanupScenarioProject,
} from './runner.js';

test('Scenario 1: simple code modification generates and applies a patch successfully', async () => {
  const result = await runSimpleModificationScenario();
  try {
    assert.equal(result.task.status, 'completed');
    assert.equal(result.loopResult.success, true);
    assert.equal(result.observations.patchGenerated, true);
    assert.equal(result.observations.testsPassed, true);
    assert.equal(result.observations.syntaxChecked, true);
  } finally {
    cleanupScenarioProject(result.projectDir);
  }
});

test('Scenario 2: refactoring creates a helper file and updates imports', async () => {
  const result = await runRefactoringScenario();
  try {
    assert.equal(result.task.status, 'completed');
    assert.equal(result.observations.newFileCreated, true);
    assert.equal(result.observations.originalFileUpdated, true);
    assert.equal(result.observations.importsUpdated, true);
  } finally {
    cleanupScenarioProject(result.projectDir);
  }
});

test('Scenario 3: TDD creates factorial implementation and tests', async () => {
  const result = await runTddScenario();
  try {
    assert.equal(result.task.status, 'completed');
    assert.equal(result.observations.implementationCreated, true);
    assert.equal(result.observations.testsCreated, true);
    assert.equal(result.observations.allTestsPass, true);
  } finally {
    cleanupScenarioProject(result.projectDir);
  }
});

test('Scenario 4: error recovery detects a failure and repairs it automatically', async () => {
  const result = await runErrorRecoveryScenario();
  try {
    assert.equal(result.task.status, 'completed');
    assert.equal(result.observations.failureDetected, true);
    assert.equal(result.observations.automaticRetryTriggered, true);
    assert.equal(result.observations.eventuallySucceeded, true);
    assert.ok((result.observations.attempts as number) >= 2);
  } finally {
    cleanupScenarioProject(result.projectDir);
  }
});

test('runner executes all e2e scenarios and returns a consolidated report', async () => {
  const results = await runAllE2EScenarios();
  assert.equal(results.length >= 4, true);
  assert.deepEqual(results.map((entry) => entry.name), [
    'simple-modification',
    'refactoring',
    'tdd-factorial',
    'error-recovery',
  ]);
  assert.ok(results.every((entry) => entry.task.status === 'completed'));
  assert.ok(results.every((entry) => entry.loopResult.success));
});

/**
 * Runtime state machine integration example.
 */

import { RuntimeStateMachine } from './runtime.ts';
import { sessionManager } from './session.ts';
import { qwenRouter } from '../model/router.ts';
import { recoveryEngine } from './repairer.ts';

async function main(): Promise<void> {
  const session = sessionManager.createSession({
    rootGoal: 'Implement runtime-managed task execution',
  });

  const runtime = new RuntimeStateMachine(
    {
      session: sessionManager,
      router: qwenRouter,
      repairer: recoveryEngine,
      executor: {
        async execute(task) {
          return {
            success: true,
            summary: `Executed ${task.intent}`,
            artifacts: [
              {
                id: `${task.id}-log`,
                type: 'log',
                path: `runtime/${task.id}.log`,
                content: 'Execution completed successfully',
              },
            ],
          };
        },
        async review(task) {
          return {
            approved: true,
            summary: `Reviewed ${task.intent}`,
            artifacts: [
              {
                id: `${task.id}-review`,
                type: 'log',
                path: `runtime/${task.id}-review.log`,
                content: 'Verification passed',
              },
            ],
          };
        },
      },
    },
    {
      persistencePath: '.jackcode/runtime-example.json',
      autoPersist: true,
    }
  );

  runtime.on('state-changed', ({ task, from, to }) => {
    console.log(`[runtime] ${task.id}: ${from} -> ${to}`);
  });

  const task = runtime.createTask('Add runtime orchestration demo', {
    sessionId: session.id,
    priority: 'high',
    timeoutMs: 30000,
  });

  runtime.setPlan(task.id, {
    estimatedTokens: 2048,
    targetModel: 'qwen',
    steps: [
      {
        id: 'step-1',
        description: 'Create runtime demo flow',
        targetFiles: ['src/core/runtime.example.ts'],
        dependencies: [],
      },
    ],
  });

  const result = await runtime.runTask(task.id);
  console.log(`[runtime] final state=${result.state} status=${result.status}`);
}

void main();

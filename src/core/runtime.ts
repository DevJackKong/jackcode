/**
 * Thread 01: Runtime State Machine
 * Core task execution lifecycle manager
 */

export type TaskState = 'plan' | 'execute' | 'repair' | 'review' | 'done' | 'error';

export type ModelTier = 'qwen' | 'deepseek' | 'gpt54';

export interface PlanStep {
  id: string;
  description: string;
  targetFiles: string[];
  dependencies: string[];
}

export interface ExecutionPlan {
  steps: PlanStep[];
  estimatedTokens: number;
  targetModel: ModelTier;
}

export interface Artifact {
  id: string;
  type: 'file' | 'patch' | 'log';
  path: string;
  content?: string;
}

export interface ErrorLog {
  timestamp: number;
  state: TaskState;
  message: string;
  recoverable: boolean;
}

export interface TaskContext {
  id: string;
  state: TaskState;
  intent: string;
  plan?: ExecutionPlan;
  attempts: number;
  maxAttempts: number;
  artifacts: Artifact[];
  errors: ErrorLog[];
}

export interface StateTransition {
  from: TaskState;
  to: TaskState;
  validator?: (ctx: TaskContext) => boolean;
}

const ALLOWED_TRANSITIONS: StateTransition[] = [
  { from: 'plan', to: 'execute', validator: (ctx) => ctx.plan !== undefined },
  { from: 'execute', to: 'review' },
  { from: 'execute', to: 'repair', validator: (ctx) => ctx.errors.length > 0 },
  { from: 'repair', to: 'execute', validator: (ctx) => ctx.attempts < ctx.maxAttempts },
  { from: 'review', to: 'done' },
  { from: 'repair', to: 'error', validator: (ctx) => ctx.attempts >= ctx.maxAttempts },
];

export class RuntimeStateMachine {
  private tasks: Map<string, TaskContext> = new Map();

  createTask(id: string, intent: string, maxAttempts = 3): TaskContext {
    const task: TaskContext = {
      id,
      state: 'plan',
      intent,
      attempts: 0,
      maxAttempts,
      artifacts: [],
      errors: [],
    };
    this.tasks.set(id, task);
    return task;
  }

  getTask(id: string): TaskContext | undefined {
    return this.tasks.get(id);
  }

  transition(id: string, toState: TaskState): TaskContext {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }

    const transition = ALLOWED_TRANSITIONS.find(
      (t) => t.from === task.state && t.to === toState
    );

    if (!transition) {
      throw new Error(
        `Invalid transition: ${task.state} -> ${toState}`
      );
    }

    if (transition.validator && !transition.validator(task)) {
      throw new Error(
        `Transition validation failed: ${task.state} -> ${toState}`
      );
    }

    task.state = toState;
    return task;
  }

  setPlan(id: string, plan: ExecutionPlan): TaskContext {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    if (task.state !== 'plan') {
      throw new Error(`Cannot set plan in state: ${task.state}`);
    }
    task.plan = plan;
    return task;
  }

  addError(id: string, message: string, recoverable = true): TaskContext {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    task.errors.push({
      timestamp: Date.now(),
      state: task.state,
      message,
      recoverable,
    });
    if (task.state === 'execute' || task.state === 'repair') {
      task.attempts++;
    }
    return task;
  }

  addArtifact(id: string, artifact: Artifact): TaskContext {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error(`Task ${id} not found`);
    }
    task.artifacts.push(artifact);
    return task;
  }

  getTasksByState(state: TaskState): TaskContext[] {
    return Array.from(this.tasks.values()).filter((t) => t.state === state);
  }

  routeToModel(task: TaskContext): ModelTier | null {
    switch (task.state) {
      case 'plan':
      case 'execute':
        return 'qwen';
      case 'repair':
        return 'deepseek';
      case 'review':
        return 'gpt54';
      default:
        return null;
    }
  }
}

export const runtime = new RuntimeStateMachine();

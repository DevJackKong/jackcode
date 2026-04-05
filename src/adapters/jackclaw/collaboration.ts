/**
 * JackClaw Collaboration Adapter
 * Thread 15: Subagent task delegation, coordination, communication,
 * monitoring, and handoff orchestration.
 */

import { randomUUID } from 'node:crypto';
import type {
  AggregatedResult,
  CollaborationAdapterMetrics,
  CollaborationMessage,
  CollaborationMetricsSnapshot,
  CollaborationNodeHealth,
  CollaborationTaskRecord,
  CoordinationLock,
  DirectMessageOptions,
  GeneratedFile,
  HandoffStateSnapshot,
  MessageOrderingMode,
  NodeAssignment,
  NodeConsensusState,
  NodeSelectionReason,
  SubagentHandle,
  SubagentOutputs,
  SubagentPoolConfig,
  SubagentResult,
  SubagentStatus,
  SubagentTask,
  TaskHandoffEvent,
  TaskHandoffRecord,
} from './types/collaboration.js';
import type { Patch } from '../../types/patch.js';

const TERMINAL_STATUSES: ReadonlySet<SubagentStatus> = new Set([
  'success',
  'failure',
  'timeout',
  'cancelled',
]);

interface Waiter {
  resolve: (result: SubagentResult) => void;
  reject: (error: Error) => void;
  timeout?: ReturnType<typeof setTimeout>;
}

interface NodeRuntimeState {
  assignment: NodeAssignment;
  activeTaskIds: Set<string>;
  completedTaskIds: Set<string>;
  failedTaskIds: Set<string>;
  lastHeartbeatAt: number;
  leasedLocks: Set<string>;
  deliveredMessageIds: Set<string>;
  lastSequenceByChannel: Map<string, number>;
  metrics: {
    tasksCompleted: number;
    tasksFailed: number;
    totalLatencyMs: number;
    totalTokens: number;
    handoffsIn: number;
    handoffsOut: number;
    stolenTasks: number;
  };
}

interface TaskRuntimeState {
  task: SubagentTask;
  handle: SubagentHandle;
  assignedNodeId: string;
  attempts: number;
  enqueuedAt: number;
  startedAt?: number;
  updatedAt: number;
  worker?: Promise<void>;
  lastResult?: SubagentResult;
  consensus?: NodeConsensusState;
  handoffs: TaskHandoffRecord[];
  stateSnapshot?: HandoffStateSnapshot;
}

interface LockState {
  lock: CoordinationLock;
  queue: string[];
}

export interface CollaborationAdapterDependencies {
  now?: () => number;
  timer?: (ms: number) => Promise<void>;
}

export interface SpawnOptions {
  preferredNodeId?: string;
}

const DEFAULT_CONFIG: SubagentPoolConfig = {
  maxConcurrent: 5,
  defaultTimeout: 300_000,
  maxRetries: 2,
  nodeHeartbeatTimeoutMs: 30_000,
  deadlockTimeoutMs: 5_000,
  messageHistoryLimit: 1_000,
  maxTasksPerNode: 3,
  workStealing: true,
};

function sortByPriorityThenAge(a: TaskRuntimeState, b: TaskRuntimeState): number {
  const priorityDelta = b.task.priority - a.task.priority;
  if (priorityDelta !== 0) {
    return priorityDelta;
  }
  return a.enqueuedAt - b.enqueuedAt;
}

function average(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function normalizePriority(priority: number): number {
  if (!Number.isFinite(priority)) {
    return 0.5;
  }
  return Math.max(0, Math.min(1, priority));
}

/**
 * Collaboration adapter implementation.
 */
export class JackClawCollaborationAdapter {
  private readonly config: SubagentPoolConfig;
  private readonly now: () => number;
  private readonly timer: (ms: number) => Promise<void>;

  private readonly activeAgents = new Map<string, SubagentHandle>();
  private readonly completedResults = new Map<string, SubagentResult>();
  private readonly taskStates = new Map<string, TaskRuntimeState>();
  private readonly taskIdToHandleId = new Map<string, string>();
  private readonly waiters = new Map<string, Waiter[]>();
  private readonly eventListeners: Array<(event: TaskHandoffEvent) => void> = [];
  private readonly nodes = new Map<string, NodeRuntimeState>();
  private readonly queuedTaskIds: string[] = [];
  private readonly messageLog: CollaborationMessage[] = [];
  private readonly locks = new Map<string, LockState>();
  private readonly dependencyGraph = new Map<string, Set<string>>();
  private readonly taskStatusById = new Map<string, CollaborationTaskRecord>();
  private readonly consensusByTaskId = new Map<string, NodeConsensusState>();
  private readonly handoffsByTaskId = new Map<string, TaskHandoffRecord[]>();
  private readonly assignedTasksByNode = new Map<string, Set<string>>();

  private runningCount = 0;
  private sequenceNumber = 0;
  private messageSequence = 0;

  constructor(
    config: Partial<SubagentPoolConfig> = {},
    dependencies: CollaborationAdapterDependencies = {},
  ) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.now = dependencies.now ?? (() => Date.now());
    this.timer = dependencies.timer ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async spawn(task: SubagentTask, options: SpawnOptions = {}): Promise<SubagentHandle> {
    const normalizedTask = this.normalizeTask(task);
    const subagentId = randomUUID();
    const now = this.now();
    const assignedNodeId = this.selectNode(normalizedTask, options.preferredNodeId).nodeId;
    const handle: SubagentHandle = {
      id: subagentId,
      taskId: normalizedTask.taskId,
      status: 'pending',
      createdAt: now,
      assignedNodeId,
      priority: normalizedTask.priority,
      sequence: ++this.sequenceNumber,
    };

    const runtimeState: TaskRuntimeState = {
      task: normalizedTask,
      handle,
      assignedNodeId,
      attempts: 0,
      enqueuedAt: now,
      updatedAt: now,
      handoffs: [],
    };

    this.activeAgents.set(handle.id, handle);
    this.taskStates.set(handle.id, runtimeState);
    this.taskIdToHandleId.set(normalizedTask.taskId, handle.id);
    this.taskStatusById.set(normalizedTask.taskId, this.createTaskRecord(runtimeState));
    this.enqueueTask(handle.id);
    this.assignTaskToNode(assignedNodeId, normalizedTask.taskId);

    this.emitEvent({
      type: 'spawn',
      timestamp: now,
      handle: { ...handle },
      nodeId: assignedNodeId,
      taskId: normalizedTask.taskId,
    });

    this.schedule();
    return handle;
  }

  async waitFor(handle: SubagentHandle): Promise<SubagentResult> {
    const existing = this.completedResults.get(handle.id);
    if (existing) {
      return existing;
    }

    const current = this.activeAgents.get(handle.id);
    if (!current) {
      throw new Error(`Subagent ${handle.id} not found`);
    }

    if (TERMINAL_STATUSES.has(current.status)) {
      return this.completedResults.get(handle.id)
        ?? this.buildResult(current, current.taskId, current.status as 'success' | 'failure' | 'timeout' | 'cancelled');
    }

    return new Promise((resolve, reject) => {
      const timeoutMs = this.getTaskTimeout(handle.id);
      const waiter: Waiter = { resolve, reject };
      if (timeoutMs > 0) {
        waiter.timeout = setTimeout(() => {
          const liveHandle = this.activeAgents.get(handle.id);
          if (!liveHandle || TERMINAL_STATUSES.has(liveHandle.status)) {
            return;
          }
          const result = this.buildResult(liveHandle, liveHandle.taskId, 'timeout', {
            errors: [`Subagent ${handle.id} timed out`],
          });
          this.finalizeHandle(liveHandle, result);
        }, timeoutMs);
      }

      const list = this.waiters.get(handle.id) ?? [];
      list.push(waiter);
      this.waiters.set(handle.id, list);
    });
  }

  async cancel(handle: SubagentHandle): Promise<void> {
    const current = this.activeAgents.get(handle.id);
    if (!current) {
      throw new Error(`Subagent ${handle.id} not found`);
    }

    if (TERMINAL_STATUSES.has(current.status)) {
      return;
    }

    const result = this.buildResult(current, current.taskId, 'cancelled', {
      errors: ['Subagent cancelled'],
    });
    this.finalizeHandle(current, result);
  }

  async status(handle: SubagentHandle): Promise<SubagentStatus> {
    return this.activeAgents.get(handle.id)?.status
      ?? this.completedResults.get(handle.id)?.status
      ?? 'cancelled';
  }

  aggregate(results: SubagentResult[]): AggregatedResult {
    const allSuccess = results.every((result) => result.status === 'success');
    const failures = results.filter((result) => result.status !== 'success').map((result) => result.taskId);

    const combined: AggregatedResult['combined'] = {
      files: [],
      analysis: [],
      patches: [],
      verifications: [],
      metadata: [],
    };

    for (const result of results) {
      if (result.outputs.files) {
        combined.files.push(...result.outputs.files);
      }
      if (result.outputs.analysis) {
        combined.analysis.push(result.outputs.analysis);
      }
      if (result.outputs.patch) {
        combined.patches.push(result.outputs.patch as Patch);
      }
      if (typeof result.outputs.verification === 'boolean') {
        combined.verifications.push(result.outputs.verification);
      }
      if (result.outputs.metadata) {
        combined.metadata.push(result.outputs.metadata);
      }
    }

    const totals = results.reduce(
      (acc, result) => ({
        duration: acc.duration + Math.max(0, result.metrics.endTime - result.metrics.startTime),
        tokensUsed: acc.tokensUsed + result.metrics.tokensUsed,
        estimatedCost: acc.estimatedCost + (result.metrics.estimatedCost ?? 0),
      }),
      { duration: 0, tokensUsed: 0, estimatedCost: 0 },
    );

    return {
      results,
      allSuccess,
      combined,
      totals,
      failures,
    };
  }

  onHandoff(listener: (event: TaskHandoffEvent) => void): void {
    this.eventListeners.push(listener);
  }

  offHandoff(listener: (event: TaskHandoffEvent) => void): void {
    const index = this.eventListeners.indexOf(listener);
    if (index >= 0) {
      this.eventListeners.splice(index, 1);
    }
  }

  registerNode(node: NodeAssignment): void {
    const now = this.now();
    const existing = this.nodes.get(node.nodeId);
    const runtimeState: NodeRuntimeState = existing ?? {
      assignment: node,
      activeTaskIds: new Set(),
      completedTaskIds: new Set(),
      failedTaskIds: new Set(),
      lastHeartbeatAt: now,
      leasedLocks: new Set(),
      deliveredMessageIds: new Set(),
      lastSequenceByChannel: new Map(),
      metrics: {
        tasksCompleted: 0,
        tasksFailed: 0,
        totalLatencyMs: 0,
        totalTokens: 0,
        handoffsIn: 0,
        handoffsOut: 0,
        stolenTasks: 0,
      },
    };

    runtimeState.assignment = {
      ...node,
      capacity: Math.max(1, node.capacity ?? this.config.maxTasksPerNode ?? 1),
      loadScore: node.loadScore ?? existing?.assignment.loadScore ?? 0,
      status: node.status ?? 'online',
      labels: [...(node.labels ?? [])],
      lastSeenAt: now,
    };
    runtimeState.lastHeartbeatAt = now;

    this.nodes.set(node.nodeId, runtimeState);
    if (!this.assignedTasksByNode.has(node.nodeId)) {
      this.assignedTasksByNode.set(node.nodeId, new Set());
    }
  }

  heartbeatNode(nodeId: string, loadScore?: number): CollaborationNodeHealth {
    const node = this.ensureNode(nodeId);
    const now = this.now();
    node.lastHeartbeatAt = now;
    if (typeof loadScore === 'number') {
      node.assignment.loadScore = Math.max(0, loadScore);
    }
    if (node.assignment.status === 'suspect' || node.assignment.status === 'offline') {
      node.assignment.status = 'online';
    }
    node.assignment.lastSeenAt = now;
    return this.toNodeHealth(node);
  }

  monitorNodes(): CollaborationNodeHealth[] {
    const now = this.now();
    const timeout = this.config.nodeHeartbeatTimeoutMs ?? DEFAULT_CONFIG.nodeHeartbeatTimeoutMs!;

    for (const node of this.nodes.values()) {
      const delta = now - node.lastHeartbeatAt;
      if (delta > timeout * 2) {
        node.assignment.status = 'offline';
      } else if (delta > timeout) {
        node.assignment.status = 'suspect';
      }
    }

    this.recoverFailedNodes();
    return this.getNodeHealth();
  }

  getNodeHealth(): CollaborationNodeHealth[] {
    return Array.from(this.nodes.values())
      .map((node) => this.toNodeHealth(node))
      .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  getTaskStatus(taskId: string): CollaborationTaskRecord | undefined {
    const record = this.taskStatusById.get(taskId);
    return record ? { ...record, handoffs: [...record.handoffs] } : undefined;
  }

  getMetrics(): CollaborationMetricsSnapshot {
    const taskRecords = Array.from(this.taskStatusById.values());
    const latencies = taskRecords
      .map((record) => record.completedAt && record.startedAt ? record.completedAt - record.startedAt : 0)
      .filter((value) => value > 0);

    const completed = taskRecords.filter((record) => record.status === 'success').length;
    const failed = taskRecords.filter((record) => record.status === 'failure' || record.status === 'timeout').length;
    const cancelled = taskRecords.filter((record) => record.status === 'cancelled').length;

    return {
      activeTasks: this.runningCount,
      queuedTasks: this.queuedTaskIds.length,
      completedTasks: completed,
      failedTasks: failed,
      cancelledTasks: cancelled,
      registeredNodes: this.nodes.size,
      suspectNodes: Array.from(this.nodes.values()).filter((node) => node.assignment.status === 'suspect').length,
      offlineNodes: Array.from(this.nodes.values()).filter((node) => node.assignment.status === 'offline').length,
      messagesSent: this.messageLog.length,
      handoffs: Array.from(this.handoffsByTaskId.values()).reduce((sum, value) => sum + value.length, 0),
      averageTaskLatencyMs: average(latencies),
    };
  }

  getTaskDistribution(): Record<string, string[]> {
    const distribution: Record<string, string[]> = {};
    for (const [nodeId, tasks] of this.assignedTasksByNode.entries()) {
      distribution[nodeId] = Array.from(tasks).sort();
    }
    return distribution;
  }

  getMessageLog(): CollaborationMessage[] {
    return this.messageLog.map((message) => ({
      ...message,
      payload: structuredClone(message.payload),
    }));
  }

  async sendMessage(
    fromNodeId: string,
    toNodeId: string,
    payload: Record<string, unknown>,
    options: DirectMessageOptions = {},
  ): Promise<CollaborationMessage> {
    this.ensureNode(fromNodeId);
    this.ensureNode(toNodeId);

    const ordering = options.ordering ?? 'per-channel';
    const channel = options.channel ?? `direct:${fromNodeId}:${toNodeId}`;
    const message = this.createMessage({
      kind: 'direct',
      fromNodeId,
      recipients: [toNodeId],
      payload,
      channel,
      ordering,
    });
    this.deliverMessage(message);
    return message;
  }

  async broadcast(
    fromNodeId: string,
    payload: Record<string, unknown>,
    channel = 'broadcast',
  ): Promise<CollaborationMessage> {
    this.ensureNode(fromNodeId);
    const recipients = Array.from(this.nodes.keys()).filter((nodeId) => nodeId !== fromNodeId);
    const message = this.createMessage({
      kind: 'broadcast',
      fromNodeId,
      recipients,
      payload,
      channel,
      ordering: 'global',
    });
    this.deliverMessage(message);
    return message;
  }

  async acquireLock(resourceId: string, nodeId: string, ttlMs = this.config.deadlockTimeoutMs ?? 5_000): Promise<boolean> {
    this.ensureNode(nodeId);
    this.preventDeadlock(nodeId, resourceId);

    const existing = this.locks.get(resourceId);
    const now = this.now();
    if (!existing || existing.lock.expiresAt <= now) {
      const lock: CoordinationLock = {
        resourceId,
        ownerNodeId: nodeId,
        acquiredAt: now,
        expiresAt: now + ttlMs,
      };
      this.locks.set(resourceId, { lock, queue: [] });
      this.ensureNode(nodeId).leasedLocks.add(resourceId);
      return true;
    }

    if (existing.lock.ownerNodeId === nodeId) {
      existing.lock.expiresAt = now + ttlMs;
      return true;
    }

    if (!existing.queue.includes(nodeId)) {
      existing.queue.push(nodeId);
    }
    return false;
  }

  releaseLock(resourceId: string, nodeId: string): boolean {
    const current = this.locks.get(resourceId);
    if (!current || current.lock.ownerNodeId !== nodeId) {
      return false;
    }

    const node = this.ensureNode(nodeId);
    node.leasedLocks.delete(resourceId);
    const nextOwnerId = current.queue.shift();
    if (!nextOwnerId) {
      this.locks.delete(resourceId);
      return true;
    }

    const now = this.now();
    current.lock = {
      resourceId,
      ownerNodeId: nextOwnerId,
      acquiredAt: now,
      expiresAt: now + (this.config.deadlockTimeoutMs ?? 5_000),
    };
    this.ensureNode(nextOwnerId).leasedLocks.add(resourceId);
    return true;
  }

  async buildConsensus(taskId: string, nodeIds: string[], votes: Record<string, boolean>): Promise<NodeConsensusState> {
    for (const nodeId of nodeIds) {
      this.ensureNode(nodeId);
    }

    const approvals = nodeIds.filter((nodeId) => votes[nodeId] === true);
    const rejectedBy = nodeIds.filter((nodeId) => votes[nodeId] === false);
    const reached = approvals.length > nodeIds.length / 2;
    const consensus: NodeConsensusState = {
      taskId,
      participants: [...nodeIds],
      approvals,
      rejectedBy,
      reached,
      decidedAt: this.now(),
    };

    this.consensusByTaskId.set(taskId, consensus);
    const handleId = this.taskIdToHandleId.get(taskId);
    if (handleId) {
      const taskState = this.taskStates.get(handleId);
      if (taskState) {
        taskState.consensus = consensus;
        this.taskStatusById.set(taskId, this.createTaskRecord(taskState));
      }
    }

    return consensus;
  }

  resolveConflict(taskId: string, contenders: Array<{ nodeId: string; score: number; reason?: string }>): string {
    if (contenders.length === 0) {
      throw new Error(`No contenders available for task ${taskId}`);
    }

    const winner = [...contenders].sort((a, b) => {
      const scoreDelta = b.score - a.score;
      return scoreDelta !== 0 ? scoreDelta : a.nodeId.localeCompare(b.nodeId);
    })[0];

    return winner.nodeId;
  }

  async handoffTask(
    taskId: string,
    toNodeId: string,
    reason: TaskHandoffRecord['reason'] = 'rebalancing',
    stateSnapshot?: HandoffStateSnapshot,
  ): Promise<TaskHandoffRecord> {
    const handleId = this.taskIdToHandleId.get(taskId);
    if (!handleId) {
      throw new Error(`Task ${taskId} not found`);
    }

    const taskState = this.taskStates.get(handleId);
    if (!taskState) {
      throw new Error(`Task ${taskId} not active`);
    }

    this.ensureNode(toNodeId);
    const fromNodeId = taskState.assignedNodeId;
    if (fromNodeId === toNodeId) {
      throw new Error(`Task ${taskId} is already assigned to node ${toNodeId}`);
    }

    const record: TaskHandoffRecord = {
      taskId,
      fromNodeId,
      toNodeId,
      transferredAt: this.now(),
      reason,
      stateSnapshot: stateSnapshot ?? this.captureState(taskId),
      resumed: false,
    };

    taskState.assignedNodeId = toNodeId;
    taskState.handle.assignedNodeId = toNodeId;
    taskState.stateSnapshot = record.stateSnapshot;
    taskState.handoffs.push(record);
    this.handoffsByTaskId.set(taskId, [...taskState.handoffs]);

    this.unassignTaskFromNode(fromNodeId, taskId);
    this.assignTaskToNode(toNodeId, taskId);
    this.ensureNode(fromNodeId).metrics.handoffsOut += 1;
    this.ensureNode(toNodeId).metrics.handoffsIn += 1;
    this.taskStatusById.set(taskId, this.createTaskRecord(taskState));

    this.emitEvent({
      type: 'handoff',
      timestamp: record.transferredAt,
      handle: { ...taskState.handle },
      taskId,
      fromNodeId,
      nodeId: toNodeId,
      handoff: record,
    });

    return record;
  }

  captureState(taskId: string): HandoffStateSnapshot {
    const handleId = this.taskIdToHandleId.get(taskId);
    if (!handleId) {
      throw new Error(`Task ${taskId} not found`);
    }

    const state = this.taskStates.get(handleId);
    if (!state) {
      throw new Error(`Task ${taskId} not active`);
    }

    return {
      taskId,
      progress: state.handle.status,
      assignedNodeId: state.assignedNodeId,
      attempts: state.attempts,
      context: structuredClone(state.task.context),
      metadata: {
        queuedAt: state.enqueuedAt,
        startedAt: state.startedAt,
        updatedAt: state.updatedAt,
      },
    };
  }

  async resumeTask(taskId: string): Promise<SubagentHandle> {
    const handleId = this.taskIdToHandleId.get(taskId);
    if (!handleId) {
      throw new Error(`Task ${taskId} not found`);
    }

    const taskState = this.taskStates.get(handleId);
    if (!taskState) {
      throw new Error(`Task ${taskId} not active`);
    }

    const latest = taskState.handoffs.at(-1);
    if (!latest) {
      return taskState.handle;
    }

    latest.resumed = true;
    taskState.updatedAt = this.now();
    this.taskStatusById.set(taskId, this.createTaskRecord(taskState));
    return taskState.handle;
  }

  stealWork(requestingNodeId: string): string | null {
    this.ensureNode(requestingNodeId);
    if (this.config.workStealing === false) {
      return null;
    }

    const donor = this.findWorkStealingDonor(requestingNodeId);
    if (!donor) {
      return null;
    }

    const donorTasks = Array.from(donor.activeTaskIds)
      .map((taskId) => this.getTaskStateByTaskId(taskId))
      .filter((state): state is TaskRuntimeState => Boolean(state))
      .sort(sortByPriorityThenAge);

    const candidate = donorTasks.find((state) => state.handle.status === 'pending' || state.handle.status === 'running');
    if (!candidate) {
      return null;
    }

    void this.handoffTask(candidate.task.taskId, requestingNodeId, 'work-steal');
    this.ensureNode(requestingNodeId).metrics.stolenTasks += 1;
    return candidate.task.taskId;
  }

  dispose(): void {
    for (const waiterList of this.waiters.values()) {
      for (const waiter of waiterList) {
        if (waiter.timeout) {
          clearTimeout(waiter.timeout);
        }
        waiter.reject(new Error('Collaboration adapter disposed'));
      }
    }
    this.waiters.clear();
    this.eventListeners.length = 0;
    this.activeAgents.clear();
    this.completedResults.clear();
    this.taskStates.clear();
    this.taskIdToHandleId.clear();
    this.runningCount = 0;
    this.queuedTaskIds.length = 0;
    this.messageLog.length = 0;
    this.locks.clear();
    this.nodes.clear();
    this.taskStatusById.clear();
    this.consensusByTaskId.clear();
    this.handoffsByTaskId.clear();
    this.assignedTasksByNode.clear();
  }

  getActiveCount(): number {
    return this.runningCount;
  }

  getActiveAgents(): SubagentHandle[] {
    return Array.from(this.activeAgents.values()).filter((handle) => !TERMINAL_STATUSES.has(handle.status));
  }

  getNodeAssignments(taskId: string): NodeAssignment | undefined {
    const handleId = this.taskIdToHandleId.get(taskId);
    const state = handleId ? this.taskStates.get(handleId) : undefined;
    if (!state) {
      return undefined;
    }
    return { ...this.ensureNode(state.assignedNodeId).assignment };
  }

  private normalizeTask(task: SubagentTask): SubagentTask {
    return {
      ...task,
      context: {
        ...task.context,
        files: [...task.context.files],
        fragments: [...task.context.fragments],
        constraints: [...task.context.constraints],
      },
      timeout: task.timeout > 0 ? task.timeout : this.config.defaultTimeout,
      priority: normalizePriority(task.priority),
      dependencies: [...(task.dependencies ?? [])],
      handoff: task.handoff
        ? {
            allow: task.handoff.allow !== false,
            resumeToken: task.handoff.resumeToken,
            preferredNodeId: task.handoff.preferredNodeId,
          }
        : undefined,
    };
  }

  private enqueueTask(handleId: string): void {
    this.queuedTaskIds.push(handleId);
    this.queuedTaskIds.sort((leftId, rightId) => {
      const left = this.taskStates.get(leftId);
      const right = this.taskStates.get(rightId);
      if (!left || !right) {
        return 0;
      }
      return sortByPriorityThenAge(left, right);
    });
  }

  private schedule(): void {
    while (this.runningCount < this.config.maxConcurrent && this.queuedTaskIds.length > 0) {
      const handleId = this.queuedTaskIds.shift();
      if (!handleId) {
        continue;
      }

      const taskState = this.taskStates.get(handleId);
      if (!taskState || TERMINAL_STATUSES.has(taskState.handle.status)) {
        continue;
      }

      const node = this.ensureNode(taskState.assignedNodeId);
      if (!this.canNodeAccept(node)) {
        const selected = this.selectNode(taskState.task);
        if (selected.nodeId !== taskState.assignedNodeId) {
          const fromNodeId = taskState.assignedNodeId;
          taskState.assignedNodeId = selected.nodeId;
          taskState.handle.assignedNodeId = selected.nodeId;
          this.unassignTaskFromNode(fromNodeId, taskState.task.taskId);
          this.assignTaskToNode(selected.nodeId, taskState.task.taskId);
        }
      }

      void this.executeSubagent(handleId);
    }
  }

  private async executeSubagent(handleId: string): Promise<void> {
    const state = this.taskStates.get(handleId);
    if (!state) {
      return;
    }
    if (state.handle.status === 'running') {
      return;
    }

    state.handle.status = 'running';
    state.startedAt ??= this.now();
    state.updatedAt = this.now();
    state.attempts += 1;
    this.runningCount += 1;
    this.ensureNode(state.assignedNodeId).activeTaskIds.add(state.task.taskId);
    this.taskStatusById.set(state.task.taskId, this.createTaskRecord(state));

    state.worker = this.runTask(state);
    await state.worker;
  }

  private async runTask(state: TaskRuntimeState): Promise<void> {
    const node = this.ensureNode(state.assignedNodeId);
    const deadline = state.startedAt! + state.task.timeout;

    try {
      const dependencyViolation = this.findMissingDependency(state.task);
      if (dependencyViolation) {
        throw new Error(`Task ${state.task.taskId} blocked by dependency ${dependencyViolation}`);
      }

      const executionDelay = Math.max(1, Math.min(25, Math.ceil((1 - state.task.priority) * 10) + 1));
      await this.timer(executionDelay);

      if (this.now() > deadline) {
        const timeoutResult = this.buildResult(state.handle, state.task.taskId, 'timeout', {
          errors: [`Task ${state.task.taskId} exceeded timeout`],
        });
        this.finalizeHandle(state.handle, timeoutResult);
        return;
      }

      const result = this.buildSyntheticSuccess(state);
      this.finalizeHandle(state.handle, result);
    } catch (error) {
      const failureResult = this.buildResult(state.handle, state.task.taskId, 'failure', {
        errors: [error instanceof Error ? error.message : String(error)],
      });
      node.failedTaskIds.add(state.task.taskId);
      this.finalizeHandle(state.handle, failureResult);
    }
  }

  private buildSyntheticSuccess(state: TaskRuntimeState): SubagentResult {
    const outputs: SubagentOutputs = {
      analysis: `Completed task: ${state.task.goal}`,
      metadata: {
        sessionId: state.task.sessionId,
        expectedOutputType: state.task.expectedOutput.type,
        assignedNodeId: state.assignedNodeId,
      },
    };

    if (state.task.expectedOutput.type === 'files' || state.task.expectedOutput.type === 'mixed') {
      outputs.files = [{
        path: `${state.task.taskId}.generated.txt`,
        content: `Generated output for ${state.task.goal}`,
        isNew: true,
      } satisfies GeneratedFile];
    }

    if (state.task.expectedOutput.type === 'verification') {
      outputs.verification = true;
    }

    return this.buildResult(state.handle, state.task.taskId, 'success', {
      outputs,
      metrics: {
        tokensUsed: Math.max(1, Math.ceil(state.task.goal.length / 4)),
        estimatedCost: Number((state.task.goal.length * 0.00001).toFixed(6)),
      },
    });
  }

  private buildResult(
    handle: SubagentHandle,
    taskId: string,
    status: Extract<SubagentStatus, 'success' | 'failure' | 'timeout' | 'cancelled'>,
    overrides: {
      outputs?: SubagentOutputs;
      metrics?: Partial<CollaborationAdapterMetrics>;
      errors?: string[];
    } = {},
  ): SubagentResult {
    const state = this.taskStates.get(handle.id);
    const now = this.now();
    const startTime = state?.startedAt ?? handle.createdAt;

    return {
      taskId,
      subagentId: handle.id,
      status,
      outputs: overrides.outputs ?? (status === 'success' ? { analysis: `Completed task: ${taskId}` } : {}),
      metrics: {
        startTime,
        endTime: now,
        tokensUsed: overrides.metrics?.tokensUsed ?? 0,
        estimatedCost: overrides.metrics?.estimatedCost,
        nodeId: state?.assignedNodeId,
        attempt: state?.attempts ?? 1,
      },
      errors: overrides.errors,
    };
  }

  private finalizeHandle(handle: SubagentHandle, result: SubagentResult): void {
    if (this.completedResults.has(handle.id)) {
      return;
    }

    const state = this.taskStates.get(handle.id);
    if (!state) {
      return;
    }

    handle.status = result.status;
    state.lastResult = result;
    state.updatedAt = this.now();
    this.completedResults.set(handle.id, result);
    this.runningCount = Math.max(0, this.runningCount - 1);

    const node = this.ensureNode(state.assignedNodeId);
    node.activeTaskIds.delete(state.task.taskId);
    node.completedTaskIds.add(state.task.taskId);
    node.metrics.totalLatencyMs += Math.max(0, result.metrics.endTime - result.metrics.startTime);
    node.metrics.totalTokens += result.metrics.tokensUsed;
    if (result.status === 'success') {
      node.metrics.tasksCompleted += 1;
    } else {
      node.metrics.tasksFailed += 1;
      node.failedTaskIds.add(state.task.taskId);
    }

    this.taskStatusById.set(state.task.taskId, this.createTaskRecord(state, result));
    this.resolveWaiters(handle.id, result);

    const eventType: TaskHandoffEvent['type'] = result.status === 'success'
      ? 'complete'
      : result.status === 'cancelled'
        ? 'cancel'
        : 'fail';

    this.emitEvent({
      type: eventType,
      timestamp: this.now(),
      handle: { ...handle },
      result,
      taskId: state.task.taskId,
      nodeId: state.assignedNodeId,
    });

    this.schedule();
  }

  private resolveWaiters(handleId: string, result: SubagentResult): void {
    const waiters = this.waiters.get(handleId);
    if (!waiters) {
      return;
    }

    this.waiters.delete(handleId);
    for (const waiter of waiters) {
      if (waiter.timeout) {
        clearTimeout(waiter.timeout);
      }
      waiter.resolve(result);
    }
  }

  private emitEvent(event: TaskHandoffEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[CollaborationAdapter] Event listener failed:', error);
      }
    }
  }

  private createTaskRecord(state: TaskRuntimeState, result?: SubagentResult): CollaborationTaskRecord {
    const finalResult = result ?? state.lastResult;
    return {
      taskId: state.task.taskId,
      status: finalResult?.status ?? state.handle.status,
      assignedNodeId: state.assignedNodeId,
      priority: state.task.priority,
      createdAt: state.handle.createdAt,
      startedAt: state.startedAt,
      completedAt: finalResult?.metrics.endTime,
      attempts: state.attempts,
      dependencies: [...(state.task.dependencies ?? [])],
      handoffs: [...state.handoffs],
      consensus: state.consensus,
    };
  }

  private createMessage(input: {
    kind: CollaborationMessage['kind'];
    fromNodeId: string;
    recipients: string[];
    payload: Record<string, unknown>;
    channel: string;
    ordering: MessageOrderingMode;
  }): CollaborationMessage {
    return {
      id: randomUUID(),
      kind: input.kind,
      fromNodeId: input.fromNodeId,
      recipients: [...input.recipients],
      payload: structuredClone(input.payload),
      timestamp: this.now(),
      channel: input.channel,
      ordering: input.ordering,
      sequence: ++this.messageSequence,
    };
  }

  private deliverMessage(message: CollaborationMessage): void {
    for (const recipient of message.recipients) {
      const node = this.ensureNode(recipient);
      const lastSequence = node.lastSequenceByChannel.get(message.channel) ?? 0;
      if (message.ordering === 'global' || message.ordering === 'per-channel') {
        node.lastSequenceByChannel.set(message.channel, Math.max(lastSequence, message.sequence));
      }
      node.deliveredMessageIds.add(message.id);
    }

    this.messageLog.push(message);
    const maxHistory = this.config.messageHistoryLimit ?? DEFAULT_CONFIG.messageHistoryLimit!;
    if (this.messageLog.length > maxHistory) {
      this.messageLog.splice(0, this.messageLog.length - maxHistory);
    }
  }

  private selectNode(task: SubagentTask, preferredNodeId?: string): { nodeId: string; reason: NodeSelectionReason } {
    if (this.nodes.size === 0) {
      this.registerNode({
        nodeId: 'local-node-1',
        capacity: this.config.maxTasksPerNode ?? 1,
        loadScore: 0,
        labels: ['default'],
        status: 'online',
        lastSeenAt: this.now(),
      });
    }

    if (preferredNodeId && this.nodes.has(preferredNodeId) && this.canNodeAccept(this.ensureNode(preferredNodeId))) {
      return { nodeId: preferredNodeId, reason: 'preferred' };
    }

    const onlineNodes = Array.from(this.nodes.values())
      .filter((node) => node.assignment.status === 'online' || node.assignment.status === 'suspect');

    const withCapacity = onlineNodes.filter((node) => this.canNodeAccept(node));
    const candidateNodes = (withCapacity.length > 0 ? withCapacity : onlineNodes).sort((left, right) => {
      const leftPressure = this.nodePressure(left, task.priority);
      const rightPressure = this.nodePressure(right, task.priority);
      if (leftPressure !== rightPressure) {
        return leftPressure - rightPressure;
      }
      return left.assignment.nodeId.localeCompare(right.assignment.nodeId);
    });

    const chosen = candidateNodes[0];
    if (!chosen) {
      throw new Error('No nodes available for task assignment');
    }

    return {
      nodeId: chosen.assignment.nodeId,
      reason: withCapacity.length > 0 ? 'least-loaded' : 'fallback',
    };
  }

  private nodePressure(node: NodeRuntimeState, taskPriority: number): number {
    const capacity = Math.max(1, node.assignment.capacity);
    const activeLoad = node.activeTaskIds.size / capacity;
    const queueLoad = (this.assignedTasksByNode.get(node.assignment.nodeId)?.size ?? 0) / capacity;
    const priorityBias = 1 - taskPriority;
    return (node.assignment.loadScore ?? 0) + activeLoad + queueLoad + priorityBias * 0.01;
  }

  private canNodeAccept(node: NodeRuntimeState): boolean {
    return node.assignment.status !== 'offline'
      && node.activeTaskIds.size < Math.max(1, node.assignment.capacity);
  }

  private ensureNode(nodeId: string): NodeRuntimeState {
    const node = this.nodes.get(nodeId);
    if (!node) {
      throw new Error(`Node ${nodeId} is not registered`);
    }
    return node;
  }

  private toNodeHealth(node: NodeRuntimeState): CollaborationNodeHealth {
    return {
      nodeId: node.assignment.nodeId,
      status: node.assignment.status ?? 'offline',
      loadScore: node.assignment.loadScore ?? 0,
      capacity: node.assignment.capacity,
      activeTasks: node.activeTaskIds.size,
      assignedTasks: this.assignedTasksByNode.get(node.assignment.nodeId)?.size ?? 0,
      lastHeartbeatAt: node.lastHeartbeatAt,
      averageLatencyMs: node.metrics.tasksCompleted > 0
        ? node.metrics.totalLatencyMs / node.metrics.tasksCompleted
        : 0,
      tokensUsed: node.metrics.totalTokens,
      handoffsIn: node.metrics.handoffsIn,
      handoffsOut: node.metrics.handoffsOut,
      stolenTasks: node.metrics.stolenTasks,
    };
  }

  private assignTaskToNode(nodeId: string, taskId: string): void {
    const assignments = this.assignedTasksByNode.get(nodeId) ?? new Set<string>();
    assignments.add(taskId);
    this.assignedTasksByNode.set(nodeId, assignments);
  }

  private unassignTaskFromNode(nodeId: string, taskId: string): void {
    const assignments = this.assignedTasksByNode.get(nodeId);
    if (!assignments) {
      return;
    }
    assignments.delete(taskId);
  }

  private recoverFailedNodes(): void {
    const failedNodes = Array.from(this.nodes.values()).filter((node) => node.assignment.status === 'offline');
    for (const node of failedNodes) {
      const impactedTasks = Array.from(node.activeTaskIds);
      for (const taskId of impactedTasks) {
        const taskState = this.getTaskStateByTaskId(taskId);
        if (!taskState || !taskState.task.handoff?.allow) {
          continue;
        }
        const target = this.selectNode(taskState.task, taskState.task.handoff?.preferredNodeId);
        if (target.nodeId === node.assignment.nodeId) {
          continue;
        }
        void this.handoffTask(taskId, target.nodeId, 'node-failure');
      }
    }
  }

  private findMissingDependency(task: SubagentTask): string | null {
    for (const dependency of task.dependencies ?? []) {
      const dependencyHandleId = this.taskIdToHandleId.get(dependency);
      if (!dependencyHandleId) {
        return dependency;
      }
      const result = this.completedResults.get(dependencyHandleId);
      if (!result || result.status !== 'success') {
        return dependency;
      }
    }
    return null;
  }

  private findWorkStealingDonor(requestingNodeId: string): NodeRuntimeState | null {
    const donors = Array.from(this.nodes.values())
      .filter((node) => node.assignment.nodeId !== requestingNodeId)
      .sort((left, right) => right.activeTaskIds.size - left.activeTaskIds.size);

    return donors.find((node) => node.activeTaskIds.size > Math.max(1, this.ensureNode(requestingNodeId).assignment.capacity))
      ?? donors.find((node) => node.activeTaskIds.size > 0)
      ?? null;
  }

  private getTaskStateByTaskId(taskId: string): TaskRuntimeState | undefined {
    const handleId = this.taskIdToHandleId.get(taskId);
    return handleId ? this.taskStates.get(handleId) : undefined;
  }

  private preventDeadlock(nodeId: string, resourceId: string): void {
    const awaiting = this.dependencyGraph.get(nodeId) ?? new Set<string>();
    const owner = this.locks.get(resourceId)?.lock.ownerNodeId;
    if (owner) {
      awaiting.add(owner);
      this.dependencyGraph.set(nodeId, awaiting);
      const ownerDependencies = this.dependencyGraph.get(owner);
      if (ownerDependencies?.has(nodeId)) {
        throw new Error(`Deadlock detected between ${nodeId} and ${owner}`);
      }
    }
  }

  private getTaskTimeout(handleId: string): number {
    const state = this.taskStates.get(handleId);
    return state?.task.timeout ?? this.config.defaultTimeout;
  }
}

export function createCollaborationAdapter(
  config?: Partial<SubagentPoolConfig>,
  dependencies?: CollaborationAdapterDependencies,
): JackClawCollaborationAdapter {
  return new JackClawCollaborationAdapter(config, dependencies);
}

export const collaborationAdapter = new JackClawCollaborationAdapter();

export type {
  SubagentTask,
  SubagentResult,
  SubagentHandle,
  SubagentStatus,
  SubagentOutputs,
  GeneratedFile,
  AggregatedResult,
  TaskHandoffEvent,
  SubagentPoolConfig,
  NodeAssignment,
  CollaborationMessage,
  CollaborationNodeHealth,
  CollaborationMetricsSnapshot,
  TaskHandoffRecord,
  HandoffStateSnapshot,
  NodeConsensusState,
  CollaborationTaskRecord,
  DirectMessageOptions,
  MessageOrderingMode,
};
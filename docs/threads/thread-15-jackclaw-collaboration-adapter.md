# Thread 15: JackClaw Collaboration Adapter

## Purpose
Enables JackCode to spawn and manage OpenClaw subagents for parallel task execution, delegation, and result aggregation. Provides bidirectional task handoff between JackCode sessions and OpenClaw agent runtime.

## Responsibilities
- Spawn OpenClaw subagents via `acpx` sessions API
- Manage task delegation: JackCode → OpenClaw subagent
- Collect and aggregate subagent results back to parent session
- Track subagent lifecycle (spawned, running, completed, failed)
- Handle subagent timeouts and recovery
- Route subagent outputs to appropriate JackCode contexts

## Design Decisions

### Subagent Task Model
```
JackCode Session (Parent)
    │
    ├──► Subagent A (Task: generate tests)
    │      Result: test files
    │
    ├──► Subagent B (Task: analyze impact)
    │      Result: impact report
    │
    └──► Subagent C (Task: verify changes)
           Result: verification status
```

### Handoff Protocol
1. **Spawn Phase**: JackCode creates subagent with task payload
2. **Execution Phase**: Subagent runs independently with isolated context
3. **Result Phase**: Subagent reports back via structured response
4. **Aggregation Phase**: Parent session integrates subagent results

### Task Payload Format
```typescript
interface SubagentTask {
  taskId: string;
  sessionId: string;
  goal: string;
  context: {
    files: string[];        // Relevant file paths
    fragments: ContextFragment[];
    constraints: string[];
  };
  expectedOutput: {
    type: 'files' | 'analysis' | 'patch' | 'verification';
    format: string;
  };
  timeout: number;          // Milliseconds
  priority: number;         // 0-1
}
```

### Result Format
```typescript
interface SubagentResult {
  taskId: string;
  subagentId: string;
  status: 'success' | 'failure' | 'timeout' | 'cancelled';
  outputs: {
    files?: Array<{ path: string; content: string }>;
    analysis?: string;
    patch?: Patch;
    verification?: boolean;
  };
  metrics: {
    startTime: number;
    endTime: number;
    tokensUsed: number;
  };
  errors?: string[];
}
```

## Adapter Architecture

```typescript
class JackClawCollaborationAdapter {
  // Spawn a new OpenClaw subagent
  async spawn(task: SubagentTask): Promise<SubagentHandle>;
  
  // Wait for subagent completion
  async waitFor(handle: SubagentHandle): Promise<SubagentResult>;
  
  // Cancel running subagent
  async cancel(handle: SubagentHandle): Promise<void>;
  
  // Poll for status updates
  async status(handle: SubagentHandle): Promise<SubagentStatus>;
  
  // Aggregate multiple subagent results
  aggregate(results: SubagentResult[]): AggregatedResult;
}
```

## Integration Points

### With Thread 02 (Session Context)
- Subagent tasks are tracked in parent session's task stack
- Subagent results become session context fragments
- Handoff payloads include subagent progress

### With Thread 01 (Runtime State Machine)
- Subagent spawning happens during `execute` state
- Subagent results may trigger `repair` or `review` transitions
- Parallel subagents enable concurrent execution branches

### With Thread 13 (JackClaw Node Adapter)
- Uses node adapter for OpenClaw session management
- Leverages node discovery for available agent types
- Shares authentication context

## Files

- `src/adapters/jackclaw/task-adapter.ts` - Main adapter implementation
- `src/adapters/jackclaw/types/collaboration.ts` - Collaboration types
- `src/adapters/jackclaw/subagent-pool.ts` - Subagent lifecycle management

## Future Work
- Subagent result caching for identical tasks
- Load balancing across multiple OpenClaw nodes
- Subagent-to-subagent communication channels
- Cost-based subagent optimization (cheap vs capable models)

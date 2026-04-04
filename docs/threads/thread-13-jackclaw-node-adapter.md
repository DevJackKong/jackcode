# Thread 13: JackClaw Node Adapter

## Purpose
Bridge JackCode with JackClaw Node — enables JackCode to register as a task-executing node in the JackClaw ecosystem, receive distributed tasks, and report execution results.

## Responsibilities
- Register JackCode as a JackClaw node with the Hub
- Receive and deserialize task bundles from JackClaw Hub
- Route tasks to JackCode's runtime state machine
- Report execution progress and final results back to Hub
- Maintain node identity and secure communication

## Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│ JackClaw    │◄───────►│  JackClaw   │◄───────►│   JackCode  │
│    Hub      │  HTTPS  │ Node Adapter│  Local  │   Runtime   │
└─────────────┘         └─────────────┘         └─────────────┘
                               │
                               ▼
                        ┌─────────────┐
                        │ Node Identity│
                        │   + Crypto   │
                        └─────────────┘
```

## Components

### 1. NodeIdentityManager
Manages JackClaw node identity (key pairs, node ID, registration)

```typescript
class NodeIdentityManager {
  loadOrCreate(): NodeIdentity;
  registerWithHub(hubUrl: string): Promise<void>;
  sign(payload: unknown): string;
  verify(senderId: string, payload: unknown, signature: string): boolean;
}
```

### 2. TaskReceiver
HTTP server endpoint for receiving tasks from Hub

```typescript
class TaskReceiver {
  start(port: number): void;
  onTask(handler: (task: JackClawTask) => Promise<TaskResult>): void;
  verifyMessage(msg: JackClawMessage): boolean;
}
```

### 3. TaskRouter
Maps JackClaw tasks to JackCode runtime

```typescript
class TaskRouter {
  route(task: JackClawTask): Promise<TaskResult>;
  // Converts JackClaw task format to JackCode TaskContext
  // Delegates to RuntimeStateMachine
}
```

### 4. ReportSender
Sends execution reports back to Hub

```typescript
class ReportSender {
  sendProgress(taskId: string, progress: ProgressUpdate): Promise<void>;
  sendCompletion(taskId: string, result: TaskResult): Promise<void>;
  sendDailyReport(report: DailyReport): Promise<void>;
}
```

## Data Flow

### Receiving Tasks
1. Hub sends encrypted task bundle to node's HTTP endpoint
2. TaskReceiver verifies signature and decrypts payload
3. TaskRouter converts to JackCode TaskContext
4. RuntimeStateMachine executes task through plan → execute → review
5. ReportSender streams progress updates back to Hub

### Reporting Results
1. RuntimeStateMachine completes task (state: 'done' | 'error')
2. TaskRouter packages result into JackClaw format
3. ReportSender encrypts and signs result
4. HTTPS POST to Hub's report endpoint

## Interfaces

See `src/adapters/jackclaw/node-adapter.ts` for implementation.

## Integration Notes

### With Thread 01 (Runtime State Machine)
- Node Adapter creates TaskContext from JackClaw tasks
- RuntimeStateMachine manages execution lifecycle
- Results flow back through adapter to Hub

### With Thread 02 (Session Context)
- Node sessions map to JackClaw task bundles
- Checkpoints reported as progress updates
- Handoffs preserved across model tiers

### With Thread 09-12 (Model Routers)
- Node adapter provides hub communication channel
- Model routers focus on LLM interaction
- Clean separation of concerns

## Security

- All Hub communication encrypted with node RSA keys
- Task bundles signed by Hub, verified by node
- Results signed by node, verified by Hub
- Private keys stored in `~/.jackclaw/keys/`

## Configuration

```typescript
interface JackClawAdapterConfig {
  hubUrl: string;           // JackClaw Hub URL
  nodeId?: string;          // Optional: explicit node ID
  nodeName?: string;        // Display name
  port: number;             // HTTP server port
  autoRegister: boolean;    // Auto-register with Hub on startup
  reportCron: string;       // Daily report schedule
}
```

## Future Work
- Task prioritization queue
- Multi-task parallel execution
- Node capability advertisement
- Distributed checkpoint recovery

# Thread 14: JackClaw Memory Adapter

## Purpose
Provides bidirectional memory synchronization between JackCode and JackClaw's memory system. Enables JackCode sessions to read from and write to JackClaw's long-term memory store.

## Architecture

```
┌─────────────┐         ┌──────────────────┐         ┌─────────────┐
│  JackCode   │◄───────►│  Memory Adapter  │◄───────►│  JackClaw   │
│   Session   │         │   (this thread)  │         │   Memory    │
└─────────────┘         └──────────────────┘         └─────────────┘
        │                        │                          │
        ▼                        ▼                          ▼
   SessionContext           MemoryEntry               MEMORY.md
   TaskContext              MemoryQuery               Daily Notes
   Checkpoints              SyncResult
```

## Memory Sync Modes

| Mode | Direction | Use Case |
|------|-----------|----------|
| `pull` | JackClaw → JackCode | Bootstrap session with existing context |
| `push` | JackCode → JackClaw | Persist session learnings |
| `bidirectional` | Both | Full synchronization with conflict resolution |

## Data Model

### MemoryEntry
```typescript
interface MemoryEntry {
  id: string;
  sessionId: string;
  type: MemoryEntryType;
  content: string;
  metadata: MemoryMetadata;
  timestamp: number;
  expiresAt: number | null;
}
```

### MemoryQuery
```typescript
interface MemoryQuery {
  sessionId?: string;
  types?: MemoryEntryType[];
  tags?: string[];
  since?: number;
  limit?: number;
}
```

### MemoryEntryType
- `decision` - Key decisions made during session
- `learning` - Insights and learnings
- `context` - Important context fragments
- `checkpoint` - Session checkpoint references
- `error` - Errors and their resolutions

## Sync Strategy

### Pull Flow
1. Query JackClaw memory for relevant entries
2. Filter by session tags and time range
3. Transform to JackCode ContextFragment
4. Inject into SessionContext

### Push Flow
1. Collect session artifacts marked for persistence
2. Transform to MemoryEntry format
3. Write to JackClaw memory files
4. Update sync metadata

## Conflict Resolution

| Scenario | Resolution |
|----------|------------|
| Same entry newer in JackCode | Overwrite JackClaw |
| Same entry newer in JackClaw | Keep JackClaw, flag for review |
| Entry deleted in one | Mark as deleted, don't sync back |
| Tag mismatch | Merge tags from both sources |

## Integration Notes

- Thread 02 (session-context): Receives pulled memory as context fragments
- Thread 08 (context-compressor): Memory entries may be compressed before storage
- Thread 13 (jackclaw-node-adapter): Uses node adapter for filesystem operations
- Thread 16 (cli-chat-ux): Memory sync status shown in CLI

## Files

- `src/adapters/jackclaw/memory-adapter.ts` - Main adapter implementation
- `src/types/memory-adapter.ts` - Type definitions (if needed)

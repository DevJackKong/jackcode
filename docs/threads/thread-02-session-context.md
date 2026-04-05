# Thread 02: Session Context

## Overview
Session context management for JackCode - handles state persistence, task tracking, checkpoints, and agent handoffs.

## Responsibilities
- Session lifecycle management (create, suspend, resume, close)
- Task context stack (current task, parent tasks, root goal)
- Checkpoint system for recovery and rollback
- Handoff state between models (Qwen → GPT-5.4)
- Memory integration with JackClaw

## Design Decisions

### Session State Machine
```
CREATED → ACTIVE → PAUSED → ACTIVE → CLOSED
   │         │        └─────┘      │
   │         └────────→ ERROR ──────┘
   └────────────────────────────────→
```

### Task Context Stack
- Hierarchical task tracking (root → subtask → sub-subtask)
- Each level keeps: goal, context window, completion criteria
- Natural fit for recursive coding tasks (implement → test → fix)

### Checkpoint Strategy
- **Lightweight**: file hashes + cursor positions (not full file copies)
- **Tagged**: user-defined tags for meaningful rollback points
- **Auto**: pre-action checkpoints before destructive operations

### Handoff Format
Standardized payload for model switching:
- Session summary (progress, decisions, blockers)
- Current task context
- Relevant code snippets
- Expected next actions

## Interfaces

See `src/types/session.ts` and `src/core/session.ts` for implementation.

## Integration Notes

### With Thread 01 (Runtime State Machine)
- Session owns the high-level state
- Runtime state machine manages execution flow
- Session provides context; runtime orchestrates

### With Thread 13-15 (JackClaw Adapters)
- Session persists to JackClaw memory system
- Uses `memory/` directory for session storage
- Syncs on checkpoint creation

### With Thread 10-12 (Model Routers)
- Handoff format consumed by model routers
- Session provides context window management
- Cost tracking per model usage

## Future Work
- Session replay for debugging
- Session forking (branching experiments)
- Collaborative sessions (multi-agent)

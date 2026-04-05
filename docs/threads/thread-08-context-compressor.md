# Thread 08: Context Compressor

## Purpose
Manage context packing, compression, and serialization for efficient storage and model consumption. Ensures contexts fit within token limits while preserving semantic relevance.

## Responsibilities
1. **Context Packing**: Serialize heterogeneous context fragments (code, docs, chat history) into structured payloads
2. **Token Budgeting**: Enforce model-specific token limits with configurable safety margins
3. **Compression Strategies**: Multi-tier compression (summarization, truncation, semantic deduplication)
4. **Relevance Scoring**: Rank context fragments by importance using recency, frequency, and semantic similarity
5. **Format Adaptation**: Output contexts optimized for Qwen 3.6 and GPT-5.4 formats

## Design Decisions

### Compression Pipeline
```
Raw Context → Tokenize → Budget Check → Relevance Score → Compress → Format → Output
```

### Compression Levels
| Level | Strategy | Use Case |
|-------|----------|----------|
| 0 | None | Small contexts (< 50% budget) |
| 1 | Lossless (dedupe, whitespace) | Medium contexts |
| 2 | Semantic (summary of summaries) | Large contexts |
| 3 | Aggressive (truncate + key facts only) | Overflow emergency |

### Key Types
- `ContextFragment`: Individual context unit with metadata
- `CompressedContext`: Packed and processed context ready for model
- `CompressionStrategy`: Configurable compression behavior

## API

### `ContextCompressor`
- `pack(fragments: ContextFragment[]): PackedContext` - Serialize fragments
- `compress(packed: PackedContext, budget: number): CompressedContext` - Apply compression
- `estimateTokens(text: string): number` - Fast token estimation

### `RelevanceScorer`
- `score(fragments: ContextFragment[], query: string): ScoredFragment[]` - Rank by relevance

## Integration Notes
- Consumes output from **repo-scanner** (Thread 05) and **session-context** (Thread 02)
- Feeds into **qwen-executor-router** (Thread 09) and GPT-5.4 review/recovery flows; Thread 10 is historical
- Works with **memory** module for persistence

## File Structure
```
src/repo/
  context-compressor.ts    # Main compressor implementation
  relevance-scorer.ts      # Fragment ranking logic
  types.ts                 # Repo-context specific types
src/types/
  context.ts               # Shared context types
```

## Dependencies
- Tokenizer: Simple whitespace-based estimation (no external deps for v0.1)
- Optional: tiktoken for precise GPT token counting

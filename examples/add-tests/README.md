# Add Tests Example

This example is aimed at prompts that ask JackCode to write tests.

## Files

- `src/utils.ts`
- `jackcode-task.json`

## Suggested command

```bash
node dist/cli/index.js --model qwen-3.6 "Write unit tests for examples/add-tests/src/utils.ts, covering normal cases and edge cases for slugify, groupByLength, and clamp."
```

## What to test

- `slugify()` with spaces, punctuation, uppercase text, and repeated separators
- `groupByLength()` with empty input and mixed string lengths
- `clamp()` for below-range, in-range, and above-range values

## Goal

Users can see how JackCode handles test-generation requests in the Qwen-only development path.

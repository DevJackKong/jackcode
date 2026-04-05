# Simple Refactor Example

This example gives JackCode a small TypeScript calculator with several rough edges.

## Files

- `src/calculator.ts`
- `jackcode-task.json`

## Problems to fix

- `divide()` silently returns `0` when dividing by zero
- `percentage()` does not guard against `total === 0`
- `parseAndAdd()` accepts invalid numeric input without validation
- `average()` divides by zero for an empty array

## Suggested command

```bash
node dist/cli/index.js --model qwen-3.6 "Refactor examples/simple-refactor/src/calculator.ts to use explicit validation, clear errors, and safer edge-case handling."
```

## What a good result looks like

A good refactor would:

- throw meaningful errors for invalid input
- avoid hidden fallback values
- document edge cases clearly
- keep the API easy to read

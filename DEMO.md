# JackCode Demo

This guide gives a fast way to see JackCode in action with the new Qwen-only development path.

## Architecture at a glance

- **Qwen 3.6** handles development work: refactors, fixes, test generation, implementation tasks
- **GPT-5.4** remains available for audit and review

## Quick start

From the project root:

```bash
npm install
npm run build
```

## Demo 1: Simple refactor

```bash
node dist/cli/index.js --model qwen-3.6 "Refactor examples/simple-refactor/src/calculator.ts to use proper error handling."
```

### Sample output

```text
JackCode | Model: qwen-3.6
--------------------------------------------------
Session jc-demo123  |  Mode idle  |  Model qwen-3.6  |  Messages 0  |  Pending 0  |  Idle
USER: Refactor examples/simple-refactor/src/calculator.ts to use proper error handling.
ASSISTANT: One-shot mode received: Refactor examples/simple-refactor/src/calculator.ts to use proper error handling.
```

## Demo 2: Add tests

```bash
node dist/cli/index.js --model qwen-3.6 "Write tests for examples/add-tests/src/utils.ts, including edge cases."
```

### Sample output

```text
JackCode | Model: qwen-3.6
--------------------------------------------------
USER: Write tests for examples/add-tests/src/utils.ts, including edge cases.
ASSISTANT: One-shot mode received: Write tests for examples/add-tests/src/utils.ts, including edge cases.
```

## Demo 3: Execute mode without approval stays dry-run

```bash
node dist/cli/index.js --model qwen-3.6 --execute "Fix examples/fix-bug/src/buggy.ts and explain the bug fixes."
```

### Sample output

```text
Workflow: dry-run
...
Result: approval missing. No files were changed. Re-run with --execute --approve to apply these pending changes.
```

## Demo 4: Approved execute mode applies changes

```bash
node dist/cli/index.js --model qwen-3.6 --execute --approve "Fix examples/fix-bug/src/buggy.ts and explain the bug fixes."
```

### Sample output

```text
Workflow: applied
...
Applied changes:
  - examples/fix-bug/src/buggy.ts
Result: applied 1 patch(es) across 1 file(s).
```

## Interactive demo

```bash
node dist/cli/index.js chat
```

Then try:

```text
/model qwen-3.6
/plan Refactor examples/simple-refactor/src/calculator.ts
/execute Fix examples/fix-bug/src/buggy.ts
/execute --approve Fix examples/fix-bug/src/buggy.ts
/review
/status
```

## Example task files

Each demo folder ships with a `jackcode-task.json` file. These are simple task briefs you can reuse in prompts or tooling.

- [`examples/simple-refactor/jackcode-task.json`](./examples/simple-refactor/jackcode-task.json)
- [`examples/add-tests/jackcode-task.json`](./examples/add-tests/jackcode-task.json)
- [`examples/fix-bug/jackcode-task.json`](./examples/fix-bug/jackcode-task.json)

## Where to look next

- [`examples/`](./examples/) for the full example set
- [`docs/USAGE.md`](./docs/USAGE.md) for CLI usage
- [`README.md`](./README.md) for the architecture overview

# JackCode Examples

These examples show how to use JackCode with the Qwen-first workflow.

## Prerequisites

From the project root:

```bash
npm install
npm run build
```

## Example folders

- [`simple-refactor/`](./simple-refactor/) — refactor a small calculator with weak error handling
- [`add-tests/`](./add-tests/) — add tests around utility helpers
- [`fix-bug/`](./fix-bug/) — fix a deliberately broken function

## How to run an example

JackCode currently supports one-shot, execute, and interactive CLI flows. A simple way to explore an example is to point your prompt at the files in that folder.

### 1. Review the task definition

Each example includes a `jackcode-task.json` file describing the intent, target files, and model:

```json
{
  "intent": "Refactor calculator to use proper error handling",
  "files": ["src/calculator.ts"],
  "model": "qwen-3.6"
}
```

### 2. Run a one-shot command

```bash
node dist/cli/index.js --model qwen-3.6 "Review examples/simple-refactor/src/calculator.ts and refactor it to use proper error handling."
```

### 3. Run execute mode

Dry-run first:

```bash
node dist/cli/index.js --model qwen-3.6 --execute "Fix the bug in examples/fix-bug/src/buggy.ts and explain the change."
```

Then apply for real only when you approve it:

```bash
node dist/cli/index.js --model qwen-3.6 --execute --approve "Fix the bug in examples/fix-bug/src/buggy.ts and explain the change."
```

### 4. Try interactive mode

```bash
node dist/cli/index.js chat
```

Then inside the REPL:

```text
/model qwen-3.6
/plan Add tests for examples/add-tests/src/utils.ts
/review
```

## Expected output

The current CLI now distinguishes between planning, dry-run execute, approved execute, applied, and rolled-back states. Typical output looks like this:

```text
JackCode | Model: qwen-3.6
--------------------------------------------------
Session jc-abc12345  |  Mode idle  |  Model qwen-3.6  |  Messages 0  |  Pending 0  |  Idle
USER: Review examples/simple-refactor/src/calculator.ts and refactor it to use proper error handling.
ASSISTANT: One-shot mode received: Review examples/simple-refactor/src/calculator.ts and refactor it to use proper error handling.
```

Execute mode without approval produces a truthful dry-run summary:

```text
Workflow: dry-run
...
Result: approval missing. No files were changed.
```

Approved execute mode applies a real patch:

```text
Workflow: applied
...
Applied changes:
  - examples/fix-bug/src/buggy.ts
Result: applied 1 patch(es) across 1 file(s).
```

## Tips

- Start with `--model qwen-3.6` for implementation work.
- Use `gpt-5.4` when you want a review or audit-style pass.
- Keep prompts concrete: mention the file path and the intended outcome.
- Use the example `jackcode-task.json` files as reusable task briefs.
- Interactive mode is useful for trying `/plan`, `/execute`, `/review`, and `/model` together.

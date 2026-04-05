# JackCode Usage Guide

## Architecture

JackCode now uses a simple two-model architecture:

- **Qwen 3.6** for all development work
- **GPT-5.4** for audit and final verification

The legacy reasoner path has been removed.

## CLI

### Examples

```bash
node dist/cli/index.js chat
node dist/cli/index.js --model qwen-3.6 "implement retry logic"
node dist/cli/index.js --model gpt-5.4 "review pending patch"
node dist/cli/index.js --execute "apply the planned refactor"
```

### `/model` command

```text
/model <qwen-3.6|gpt-5.4>
```

## Configuration

Project config uses two roles only:

```json
{
  "developer": "qwen-3.6",
  "auditor": "gpt-5.4"
}
```

## Workflow

1. Planner prepares an execution brief
2. Qwen 3.6 performs development work
3. Build/test loop validates implementation
4. GPT-5.4 performs final audit when needed

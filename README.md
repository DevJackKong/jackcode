# JackCode 🤖

[![npm version](https://img.shields.io/npm/v/jackcode.svg)](https://www.npmjs.com/package/jackcode)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

> AI-powered code development framework.

JackCode is an independent AI coding assistant framework with a simplified two-model architecture:

- **Qwen 3.6** — primary development model for implementation, refactors, tests, and code changes
- **GPT-5.4** — audit model for verification, review, and safety checks

DeepSeek has been removed from the active architecture to keep routing simpler, cheaper, and easier to maintain.

## Installation

### From npm

```bash
npm install -g jackcode
```

### From source

```bash
git clone https://github.com/JackClaw/jackcode.git
cd JackCode
npm install
npm run build
node dist/cli/index.js --help
```

## Quick Start

```bash
jackcode chat
jackcode "refactor auth module"
jackcode --model qwen-3.6 "implement retry logic"
jackcode --model gpt-5.4 "review pending patch"
```

### Current CLI behavior

- `jackcode "..."` runs a real planner/verifier-style CLI flow and prints a structured summary
- `jackcode --execute "..."` stays safe by default: it shows the inferred plan and pending diffs, and clearly reports that **no files were changed** without approval
- `jackcode --execute --approve "..."` performs a real patch apply using the built-in patch engine
- `jackcode --execute --approve --verify-cmd "<command>" "..."` runs post-apply verification; if verification fails, JackCode rolls the applied changes back and reports the final state truthfully
- Interactive `chat` uses the same workflow summary path for normal prompts

## Architecture

```text
Requirement → Planning → Qwen 3.6 execution → Build/Test → GPT-5.4 audit
```

## Configuration

```json
{
  "developer": "qwen-3.6",
  "auditor": "gpt-5.4"
}
```

## Documentation

- `docs/USAGE.md` — CLI usage and workflows
- `docs/API.md` — module and API reference
- `docs/MODEL_OPTIMIZATION.md` — model routing and architecture rationale
- `docs/threads/` — implementation notes for core subsystems

## Current Notes

- Default development flow uses **Qwen 3.6**
- Final verification flow uses **GPT-5.4**
- The architecture is intentionally simpler, with fewer routing branches and lower maintenance overhead

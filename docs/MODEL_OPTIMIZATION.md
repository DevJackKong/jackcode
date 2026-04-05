# Model Optimization: Qwen 3.6 Primary, DeepSeek Escalation, GPT-5.4 Audit

## Default architecture

JackCode now uses a **Qwen-first** execution model:

1. **Qwen 3.6** — primary developer for nearly all coding work
2. **DeepSeek Reasoner** — escalation-only specialist for complex planning and failure analysis
3. **GPT-5.4** — verifier/auditor for final review, security checks, and breaking-change detection

## Role split

### Qwen 3.6 — primary developer

Use Qwen by default for:

- code generation and modification
- refactors
- test generation
- documentation updates
- patch generation
- normal build/test fixes

Why:

- lowest cost per coding task
- strongest throughput for routine engineering work
- large context window and fast response profile

### DeepSeek — auxiliary specialist

Use DeepSeek only when Qwen should be guided rather than replaced.

Typical escalation triggers:

- Qwen confidence falls below `0.7`
- task touches more than `5` files
- repeated failures reach `2+` retries
- architecture-level change or dependency-graph reasoning is needed
- Qwen historical success rate for similar tasks is too low

DeepSeek should return strategy, root-cause reasoning, and file-level guidance that is then fed back into the Qwen execution path.

### GPT-5.4 — auditor/verifier

Reserve GPT-5.4 for:

- final verification
- code review
- security review
- breaking-change detection
- high-risk approval gates

This keeps expensive review quality where it matters without using GPT-5.4 as the main implementation engine.

## Cost model

Expected routing mix:

- **95%** Qwen 3.6
- **4%** DeepSeek escalation
- **1%** GPT-5.4 verification

Expected outcome:

- **60–70% lower cost** than a DeepSeek-primary architecture
- faster median execution time for normal code changes
- higher effective throughput under concurrency

## Escalation flow

```text
Task arrives
  -> policy engine selects Qwen by default
  -> Qwen capability check
      - complexity OK?
      - context window OK?
      - confidence >= threshold?
      - historical success acceptable?
  -> if yes: execute with Qwen
  -> if no: request DeepSeek guidance once
  -> retry execution with Qwen using DeepSeek guidance
  -> if task is verification/review: audit with GPT-5.4
```

## Configuration surface

Project-local config in `.jackcode.json` now exposes:

- `defaultModel: qwen-3.6`
- `escalationModel: deepseek-reasoner`
- `verificationModel: gpt-5.4`
- Qwen confidence threshold
- escalation file-count threshold
- max escalation attempts
- verification sampling controls

## Practical guidance

- Prefer Qwen unless there is a concrete escalation signal.
- Treat DeepSeek as a planning consultant, not the main executor.
- Keep GPT-5.4 rare and targeted.
- If budget pressure rises, preserve Qwen-first routing and narrow GPT-5.4 verification scope before changing execution defaults.

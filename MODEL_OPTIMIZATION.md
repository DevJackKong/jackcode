# Model Optimization Guide

## Goal

Tune JackCode so that:

- **Qwen 3.6** is the default high-throughput executor
- **DeepSeek** is the selective reasoning escalator
- **GPT-5.4** is the high-precision verifier and repair supervisor

This document focuses on how each model should be used, prompted, and gated.

## 1. Qwen 3.6 optimization guide

## Desired role

Qwen should be the **default implementation engine**.

Use it for:

- straightforward code edits
- implementation from clear requirements
- narrow bug fixes
- bulk/batch edits with shared pattern
- small-to-medium refactors
- code transformations where patch determinism matters more than deep reasoning

Do not force Qwen to do all the thinking. Let it do the **doing**.

## Recommended Qwen execution modes

Introduce explicit prompt modes instead of a single generic executor prompt.

### A. Patch mode
Use for focused edits.

Prompt shape:

- system:
  - you are patching an existing repo
  - change only necessary files
  - preserve surrounding behavior
  - prefer minimal diff
  - if information is missing, state assumptions explicitly
- user:
  - task intent
  - affected files
  - relevant symbols
  - failing test/error
  - acceptance criteria
  - return format

### B. Refactor mode
Use for multi-file internal improvements.

Prompt should add:

- preserve external interfaces unless instructed otherwise
- update all call sites
- keep naming/style consistent
- avoid unrelated cleanup
- produce ordered change plan before diff

### C. Test-fix mode
Use when tests fail but intent is clear.

Prompt should add:

- prioritize making implementation satisfy existing intended behavior
- do not rewrite tests unless clearly wrong
- explain mismatch between test expectation and code path

### D. Batch transformation mode
Use for repeated changes across many files.

Prompt should add:

- infer common transformation pattern
- apply consistently across all files
- report skipped files and why

## Better Qwen system prompt template

```text
You are Qwen 3.6, the primary code executor for JackCode.

Your job is to produce precise, repository-consistent code changes.

Rules:
- Make the smallest change that fully solves the task.
- Preserve public behavior unless the task explicitly changes it.
- Keep style, naming, and patterns aligned with nearby code.
- If multiple files are involved, maintain cross-file consistency.
- Do not invent APIs, imports, or files unless strongly supported by context.
- If context is insufficient, state assumptions briefly and proceed conservatively.
- Prefer implementation-ready output over discussion.
- Before finalizing, mentally check: syntax, imports, call sites, tests, and unintended regressions.
```

## Qwen prompt engineering improvements

### Add structured input sections
Qwen performs better when inputs are segmented.

Recommended sections:

- `TASK`
- `REPO_FACTS`
- `AFFECTED_FILES`
- `RELEVANT_SYMBOLS`
- `ERRORS_OR_TESTS`
- `CONSTRAINTS`
- `OUTPUT_FORMAT`

### Add self-check instructions
Before returning, ask Qwen to internally verify:

- syntax/parsing plausibility
- import/export consistency
- function signature compatibility
- changed callers/callees
- whether tests need updates

### Force explicit assumptions
If context is incomplete, require:

- `ASSUMPTIONS:` list with 1-3 items max

That is better than silent hallucination.

## Context window optimization for Qwen

Current head/tail trimming is too crude. Replace it with **importance-ranked packing**.

## Recommended context packing order

1. task intent and acceptance criteria
2. failing test block / error output
3. target file slices around edit region
4. directly referenced symbols
5. caller/callee snippets
6. related type/interface definitions
7. nearby examples from same repo
8. only then broader file or log context

## Recommended context strategies by task type

### Simple edit
- include only target file slice + type defs + one nearest usage

### Refactor
- include changed API definition + all known call sites + tests

### Debug/test failure
- include stack/error + failing test + suspected implementation + dependency edge

### Batch update
- include 2-3 representative examples, not all files in full

## Token efficiency recommendations for Qwen

### Do
- send snippets, not entire files, unless file is short
- deduplicate repeated code blocks
- include file metadata and symbol maps instead of raw large context
- cache repo facts separately from task-specific context

### Don’t
- include the whole compressed context blob blindly
- include entire logs when a few failing lines are enough
- include repeated file content across related operations

## Qwen routing recommendations

### Prefer `qwen-3.6-fast` when
- single-file simple edit
- low ambiguity
- no tools needed
- no failing test/debug context
- low-cost path desired

### Prefer `qwen-3.6` when
- medium context
- multiple related edits
- moderate ambiguity
- important but not architecture-heavy

### Prefer `qwen-coder` when
- actual code synthesis quality matters more than latency
- edits/refactors require tool support
- there are multiple call-site updates

## 2. DeepSeek escalation strategy

## Desired role

DeepSeek should be the **reasoning escalator**, not the default executor.

Use it when the system needs:

- diagnosis
- ambiguity resolution
- root cause analysis
- repair planning
- risk assessment

## Recommended escalation triggers

Escalate from Qwen to DeepSeek when any of these occur:

### Hard triggers
- same task fails verification twice
- runtime error with unclear cause
- dependency/import graph breakage
- multi-file refactor touches 4+ files
- failing tests point to behavior mismatch, not syntax
- context pressure > 80% of Qwen safe working budget

### Soft triggers
- executor confidence low
- verifier reports contradiction between files
- repeated syntax/type failures in same region
- bug report is underspecified or ambiguous

## Cost-effective escalation policy

### Do not escalate for
- obvious syntax mistakes on first attempt
- narrow one-file formatting/style repairs
- straightforward missing import fixes
- low-risk build failures with clear compiler output

### Escalate early for
- test failures after a "successful" implementation
- regressions after multi-file change
- unclear runtime bugs
- architectural changes
- conflicting signals between test, code, and intent

## Recommended DeepSeek output schema

Instead of freeform reasoning text, require structured output:

```json
{
  "rootCause": "...",
  "hypotheses": [
    { "idea": "...", "evidence": ["..."], "confidence": 0.72 }
  ],
  "chosenPlan": {
    "why": "...",
    "steps": ["..."]
  },
  "filesToInspect": ["..."],
  "risks": ["..."],
  "retryPromptHints": ["..."]
}
```

This is much more reusable by downstream Qwen retries.

## DeepSeek reasoning chain extraction improvements

Current line-splitting is readable but weak. Extract these fields instead:

- failure type
- root cause candidate(s)
- key evidence
- minimal repair strategy
- confidence score
- blocked unknowns

That lets policy and verification consume reasoning as data rather than plain text.

## Recommended DeepSeek prompt pattern

```text
You are DeepSeek Reasoner, the repair strategist for JackCode.

Analyze the failure and produce the smallest high-confidence repair plan.
Do not rewrite the entire solution.
Prioritize evidence over speculation.
If multiple causes are possible, rank them.
Return structured JSON only.
```

## Qwen + DeepSeek coordination pattern

Best pattern:

1. Qwen attempts implementation
2. GPT or build/test layer reports failure class
3. DeepSeek analyzes only the narrowed failure dossier
4. DeepSeek produces retry hints and patch constraints
5. Qwen retries with constrained prompt

That is cheaper than letting DeepSeek perform large execution directly.

## 3. GPT-5.4 verification best practices

## Desired role

GPT-5.4 should be the **final semantic reviewer and repair supervisor**.

It should answer:

- Did the patch actually solve the task?
- Did it preserve important behavior?
- Is it safe to accept?
- If not, what is the smallest next repair?

## Verification prompt improvements

Current prompt is good but too thin. Add these fields:

- original intent
- summarized execution plan
- changed files with rationale
- risky surfaces
- tests run and not run
- known assumptions from executor
- repository rules/invariants

## Recommended verifier prompt contract

```text
You are GPT-5.4, the final verifier for JackCode.

Your task is to judge whether the proposed patch should be APPROVED, REPAIRED, or REJECTED.

Judge using these priorities:
1. intent correctness
2. regression risk
3. type/build safety
4. test adequacy
5. security
6. maintainability

Treat low-severity style suggestions as non-blocking unless they indicate a deeper issue.
Return strict JSON with:
- decision
- confidence
- blockingIssues
- nonBlockingIssues
- repairInstructions
- rationale
```

## Best-practice decision policy for GPT-5.4

### APPROVE
Use when:
- task intent is satisfied
- no blocking regression/security/type issue exists
- minor polish issues may remain

### REPAIR
Use when:
- intent mostly satisfied
- fix is close
- there are narrow, actionable issues

### REJECT
Use when:
- task intent missed
- serious regression/security issue exists
- patch direction is fundamentally wrong

## Repair generation strategies for GPT-5.4

### Strategy 1: Constrained retry instructions
Preferred default.

GPT should produce:

- exact failing dimension
- affected files
- why current patch failed
- what must not be changed
- what the next executor attempt should focus on

### Strategy 2: Minimal semantic patch proposal
Use for tiny fixes where verifier is highly confident.

### Strategy 3: Candidate ranking
For high-risk tasks, have GPT rank:

- current patch
- repair option A
- repair option B

This is especially useful for refactors.

## Recommended GPT verification improvements in code

1. split issues into `blocking` vs `nonBlocking`
2. allow approval with non-blocking low-severity findings
3. make intent validation evidence-based
4. add project-invariant checks
5. add verifier-generated retry briefs for Qwen
6. use changed-file summaries plus targeted raw snippets, not only diff summaries

## 4. Router intelligence enhancements

## Dynamic model selection

Introduce a `task risk score` derived from:

- file count
- symbol graph spread
- prior failure count
- runtime vs syntax failure class
- context pressure
- importance/urgency
- historical verifier pass rate for similar tasks

### Suggested policy
- **low risk** -> Qwen fast/default
- **medium risk** -> Qwen standard/coder
- **high risk** -> DeepSeek plan then Qwen execute
- **critical verification** -> GPT-5.4 mandatory

## Response quality scoring

Add a per-attempt quality score before final verification:

- syntax confidence
- import consistency
- files touched vs files expected
- test alignment
- self-reported assumption count
- historical reliability of chosen route

Use this to decide whether to:

- send directly to verifier
- self-retry with Qwen
- escalate to DeepSeek first

## Fallback strategy

### Recommended order
- executor failure -> same Qwen variant retry only once for transient issues
- repeated failure / ambiguous issue -> DeepSeek analyze
- high-risk or near-final patch -> GPT-5.4 verify
- GPT reject -> DeepSeek repair plan -> Qwen retry

## Load balancing

Current pool metrics exist, but load balancing should also consider:

- timeout rate by model
- queue age
- recent verifier pass rate
- token pressure

Not just active request count.

## 5. Practical configuration targets

## Suggested default operational split

By task volume:

- **Qwen family:** 75-85%
- **DeepSeek:** 10-18%
- **GPT-5.4:** 5-10%

By token spend:

- **Qwen family:** 45-60%
- **DeepSeek:** 20-30%
- **GPT-5.4:** 20-35%

That keeps the system cost-efficient while preserving high-end quality control.

## Suggested acceptance metrics

### Qwen
- first-pass verifier approval rate
- average tokens per successful edit
- timeout rate
- retry rate

### DeepSeek
- escalation win rate
- repair-plan usefulness score
- reduced retries after analysis

### GPT-5.4
- verifier agreement with human review
- false reject rate
- false approve rate
- repair instruction usefulness

## Final operating principle

The winning pattern is simple:

- let **Qwen** write most code
- let **DeepSeek** think when things get messy
- let **GPT-5.4** decide what is safe and correct

If JackCode keeps those roles clean and improves structured handoffs between them, it will get much closer to an Opus 4.6-style development workflow without paying Opus-level cost on every task.

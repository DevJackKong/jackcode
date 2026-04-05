# JackCode Architecture Review

## Executive summary

JackCode already has the right high-level shape for a strong multi-model coding system:

- **Qwen router** as the fast/default executor
- **DeepSeek router** as a reasoning and repair planner
- **GPT-5.4 verifier/repairer** as the final quality gate
- **Policy engine** as the central budget and model selection layer

That is the correct architectural direction.

The main gap versus an **Opus 4.6-level coding experience** is not the absence of components, but the lack of a tighter orchestration loop between them. Today the system is still mostly **component-complete but behaviorally shallow**:

- routing is mostly rule-based, not evidence-based
- prompts are generic rather than task-specialized
- escalation exists in concept but is only lightly enforced in code
- verification is strong on heuristics but weak on semantic/project-grounded checks
- policy/cost control is well structured, but some estimates and triggers are too coarse for production-grade model orchestration

## Current architecture assessment

## 1. Qwen executor router (`src/model/qwen-router.ts`)

### What is good

- Clear separation of provider, policy, and telemetry dependencies
- Supports model variants (`qwen-3.6`, `qwen-coder`, `qwen-3.6-fast`)
- Has retries, fallback, batching, caching, and concurrency controls
- Uses context-window-aware trimming
- Includes cost estimation and budget checks before selecting cheaper variants

### What is weak

#### A. Prompting is too generic
Current system prompt:

> "You are Qwen executing code changes for JackCode. Be precise, deterministic, and patch-oriented..."

This is fine as a placeholder, but far below what an Opus-class coding stack needs. It does not encode:

- repository-aware constraints
- patch format discipline
- test/update expectations
- dependency boundaries
- refusal conditions
- multi-file coordination rules
- "think privately, answer structurally" style guidance

#### B. Context optimization is naive
`optimizeContext()` trims by keeping head/tail slices. That is cheap, but weak for code tasks because important facts usually live in:

- symbol definitions
- caller/callee sites
n- failing test blocks
- recent diffs
- config/type declarations

Head/tail trimming is fine for logs, not for serious code editing.

#### C. Policy integration is partial
`selectModel()` calls the policy engine, but only meaningfully reacts when `policyDecision.selectedModel === 'qwen'`. If policy prefers `deepseek` or `gpt54`, that signal is effectively ignored at the router level.

That means policy is advisory, not authoritative.

#### D. Escalation is only represented, not orchestrated
The router can return escalation reasons like:

- `timeout`
- `context_overflow`
- `syntax_error`
- `dependency_conflict`

But it does not directly invoke DeepSeek analysis or package a failure dossier for the next stage. It stops at classification.

#### E. Metrics are incomplete or misleading
- `calculateCacheHitRatio()` always returns `0`
- batch latency is accumulated per operation instead of tracking wall-clock batch latency
- quality of output is not tracked at all
- no per-task success score, repair rate, or verifier pass rate

#### F. There are a few implementation smells
Important examples:

- tool filtering logic is odd:
  - `filter((tool) => profile.supportsTools || tool.name.length === 0)`
  - practically, this means tools are dropped unless supported; the `tool.name.length === 0` branch is not useful
- retry/fallback pool accounting is fragile:
  - `decrementPool()` runs in both `catch` and `finally`, which can distort model load counters on retry paths
- cache key includes full context content, which is expensive and limits reuse across semantically identical tasks with small irrelevant context changes

### Gap vs Opus 4.6

Compared with an Opus-class executor, JackCode’s Qwen path is missing:

- task-specific planning before edit generation
- repository-aware context packing
- edit confidence estimation
- structured self-check before handoff to verifier
- better multi-file dependency reasoning
- explicit distinction between generation mode vs patch mode vs refactor mode

## 2. DeepSeek reasoner router (`src/model/deepseek-router.ts`)

### What is good

- Good failure classification surface:
  - syntax/type/test/dependency/runtime/unknown
- Escalation assessment is sensible and more mature than the Qwen router
- Prompt format is structured and asks for concrete sections
- Supports both `deepseek-chat` and `deepseek-reasoner`
- Tracks reasoning chain and usage separately
- Has fallback behavior and backoff

### What is weak

#### A. Escalation policy is still failure-centric only
DeepSeek is triggered mostly after failures. That is useful, but insufficient.

For Opus-level behavior, reasoning should happen not only after failure, but **before risky execution** for tasks such as:

- large refactors
- architectural edits
- multi-file API migrations
- ambiguous bug reports
- test failures with unclear intent

#### B. Reasoning extraction is shallow
`extractReasoningChain()` mainly splits raw reasoning text into lines. This gives explainability, but not reusable reasoning structure.

What is missing:

- hypotheses
- evidence per hypothesis
- chosen plan
- rejected alternatives
- confidence per step

#### C. Fallback semantics are weak
If DeepSeek fails and fallback is allowed, the router simulates a fallback response. That is safe for local development, but not sufficient for a real orchestration path. In production, fallback should produce a **structured escalation packet** for Qwen retry or GPT verification.

#### D. Policy coupling is one-way
DeepSeek consults `ModelPolicyEngine`, but there is no closed-loop feedback from actual DeepSeek outcomes back into policy. So the system does not learn that certain triggers are worth escalating earlier.

### Gap vs Opus 4.6

Compared with an Opus-class reasoner, JackCode’s DeepSeek layer is missing:

- pre-execution reasoning for high-risk tasks
- reusable reasoning schemas
- branch evaluation for repair options
- explicit causal graphs across files/tests/errors
- learned escalation thresholds from prior outcomes

## 3. GPT-5.4 verifier / repairer (`src/core/repairer.ts`)

### What is good

- Good verifier dimensions:
  - intent match
  - code quality
  - type safety
  - test coverage
  - no regression
  - security
- Combines heuristics with optional model-based verification
- Can generate minor repair patches
- Maintains verification history
- Uses strict JSON prompt contract for model verification

### What is weak

#### A. Decision logic is too strict for approval
`makeDecision()` returns `repair` if **any** low/medium/high issue exists. In practice this means near-perfect output is required for approval.

That is not how a strong verifier should behave. A good verifier should distinguish:

- blocking issues
- polish issues
- informational suggestions

Right now, informational findings can prevent approval.

#### B. Intent validation is too permissive
`validateIntent()` effectively treats many patches as fulfilling intent because this condition includes `context.changes.length >= 1` inside the success branch.

That makes intent verification weaker than it appears.

#### C. Verification is still mostly local heuristics
Strong heuristic coverage exists, but there is limited use of:

- project invariants
- AST/semantic checks
- dependency graph checks
- test-to-change mapping
- API contract diffing

#### D. Repair generation is narrow
Auto-repair mostly handles:

- style normalization
- synthetic placeholder tests

That is useful, but far from Opus-level repair behavior, where the verifier can propose narrowly scoped semantic fixes and feed them back into the executor.

#### E. Hook execution discards hook results
`executeHooks()` invokes hooks but does not use returned values, so hooks are effectively side-effect-only.

### Gap vs Opus 4.6

Compared with an Opus-class verifier, JackCode’s GPT-5.4 layer is missing:

- semantic verification grounded in repo context
- severity-aware approval thresholds
- richer repair synthesis
- patch ranking / candidate comparison
- verifier-guided retry instructions to Qwen

## 4. Policy & cost control (`src/model/policy.ts`)

### What is good

- Strong type system and clean design
- Supports rule-based routing, caching, budget tracking, reporting, downgrade logic, alerts, and optimization hints
- Clear escalation chain: `qwen -> deepseek -> gpt54`
- Real cost tracking exists via `trackUsage()`
- Includes warnings, trend reporting, and forecasts

### What is weak

#### A. Model capability matching is too coarse
Current capability dimensions are mostly:

- context
- reasoning support
- batching support
- latency
- accuracy

Missing dimensions that matter for coding:

- refactor reliability
- multi-file consistency
- patch determinism
- tool-call reliability
- verifier agreement rate
- repair success rate

#### B. Budget pressure math is somewhat inconsistent
`getBudgetPressure()` normalizes session against `perSession * 0.4` and daily against `perDay * 0.1`, which makes thresholds easier to hit and harder to interpret operationally.

This may be intentional, but it reduces transparency.

#### C. Selection is static-rule-heavy
The engine is solid, but still chooses like a classic policy table. It does not incorporate live outcome signals such as:

- recent verifier pass rate by model/task type
- recent timeout rate
- repair loop count
- output quality score

#### D. Decision cache is signature-based, not outcome-aware
Caching decisions is good, but repeated reuse without outcome weighting can preserve bad choices.

### Gap vs Opus 4.6

Compared with an Opus-class orchestrator, policy is missing:

- closed-loop quality feedback
- dynamic routing by confidence and recent performance
- per-task expected value calculations
- smarter verification budget allocation

## 5. Alignment with thread docs (09-12)

The implementation generally matches the intent of the thread docs, but the docs are more ambitious than the current behavior.

### Thread 09 mismatch
The doc describes robust fallback and aggregation. In code, fallback classification exists, but orchestration into a real repair flow is not fully wired.

### Thread 10 mismatch
The doc suggests DeepSeek as a deep reasoning escalation engine. In code, this is mostly true, but still reactive rather than strategic.

### Thread 11 mismatch
The doc positions GPT-5.4 as the ultimate gatekeeper. In code, it is a good gatekeeper, but not yet a strong semantic reviewer.

### Thread 12 mismatch
The doc describes smart fallback and cost-benefit-based escalation. In code, the rule engine is strong, but the cost-benefit layer is still mostly heuristic.

## Gap analysis vs Opus 4.6

## Code understanding depth

**Current:** good file-local understanding, moderate task classification, weak graph-level reasoning.

**Needed for Opus parity:**

- symbol graph extraction
- call-chain understanding
- test-to-implementation mapping
- config/runtime awareness
- explicit impact analysis before edit generation

## Refactoring sophistication

**Current:** Qwen can route refactors, but no dedicated refactor workflow exists.

**Needed:**

- staged refactor plan
- dependency-safe ordering
- API migration mode
- invariants preservation checks
- verifier checks against old/new interface contracts

## Test generation quality

**Current:** verifier can synthesize placeholder tests; no strong test generation orchestration is visible.

**Needed:**

- behavior-derived tests
- failure reproduction tests first
- regression test synthesis from bug reports
- minimal focused test selection

## Multi-file coordination

**Current:** batch and multi-op support exist, but execution is still largely per-operation.

**Needed:**

- shared task plan across files
- cross-file dependency map
- global edit ordering
- post-edit consistency pass before review

## Error recovery

**Current:** error classes, retries, fallback, repair planning all exist.

**Needed:**

- richer failure packets from executor to reasoner
- repair plan to patch-plan feedback loop
- verifier-guided second attempt prompts
- retry policy based on error class + confidence + prior outcomes

## Recommended target model roles

## Qwen 3.6 as primary executor

Use Qwen for:

- standard edits
- focused bug fixes
- small-to-medium refactors
- batch file updates
- first-pass implementation from clear specs

Should not be treated as a universal solver. It should be the **default patch engine**, not the whole brain.

## DeepSeek as auxiliary reasoner

Use DeepSeek for:

- repeated failures
- runtime/test/debug ambiguity
- dependency and API breakage
- high-risk refactors
- multi-file repair planning
- contradiction detection between intent, code, and tests

## GPT-5.4 as verifier/repairer

Use GPT-5.4 for:

- final verification
- approval gating
- critical-path change review
- semantic repair suggestions
- patch ranking when multiple candidate fixes exist

## Priority recommendations

## P0: Fix correctness and orchestration gaps

1. **Make policy authoritative at orchestration level**
   - If policy says DeepSeek or GPT-5.4, do not silently stay in Qwen path.
2. **Implement real cache hit metrics**
   - `calculateCacheHitRatio()` must be real.
3. **Fix verifier approval thresholds**
   - low-severity polish issues should not automatically block approval.
4. **Fix intent validation logic**
   - require evidence, not merely changed files.
5. **Turn escalation reasons into actionable handoff packets**
   - include failing files, narrowed context, tests, logs, prior attempts.

## P1: Improve model quality per role

1. Qwen: task-specific prompts and repository-aware context packing
2. DeepSeek: structured reasoning outputs with hypotheses/evidence/plan
3. GPT-5.4: semantic verification and verifier-guided repair prompts

## P2: Add closed-loop routing intelligence

1. track verifier pass rate by model/task type
2. track repair-loop count by route
3. feed those metrics back into policy selection
4. rank models by expected success-per-dollar, not just static rules

## Recommended architecture upgrade

## Proposed orchestration loop

```text
Task intake
  -> classify task + risk + token pressure
  -> policy selects primary route
  -> if low/medium risk: Qwen execute
  -> if high risk: DeepSeek plan first, then Qwen execute
  -> local self-check on executor output
  -> GPT-5.4 verify
  -> if rejected: produce structured repair brief
  -> DeepSeek analyzes repair brief
  -> Qwen retries with constrained patch prompt
  -> GPT-5.4 final verify
```

## Suggested new interfaces

### 1. Execution brief
A normalized object passed into Qwen:

- intent
- affected files
- invariants
- relevant symbols
- failing tests
- patch mode
- acceptance criteria

### 2. Failure dossier
A normalized object passed from Qwen/verifier to DeepSeek:

- failure class
- likely files
- relevant diffs
- logs/tests
- prior attempts
- budget remaining

### 3. Verification brief
A normalized object passed to GPT-5.4:

- original intent
- execution summary
- changed files
- risky surfaces
- tests run
- invariants expected

## Success criteria for “Opus 4.6-level” direction

JackCode should target measurable gains in:

- first-pass verifier approval rate
- average repair-loop count
- multi-file change success rate
- test-fix success rate
- cost per successful task
- verifier agreement with human judgment

## Final assessment

JackCode is **architecturally promising and directionally correct**. The main challenge is no longer basic plumbing. It is now about **making the three-model system behave like a coordinated team instead of three isolated modules**.

If you implement the orchestration, prompt specialization, structured handoff objects, and quality-feedback routing described here, JackCode can move meaningfully closer to an Opus 4.6-style coding experience while still keeping **Qwen 3.6 as the cost-efficient primary executor**, **DeepSeek as the reasoning escalator**, and **GPT-5.4 as the precision verifier**.

# JackCode Enhancement Roadmap

## Objective

Create a practical path for JackCode to approach **Opus 4.6-level coding behavior** using:

- **Qwen 3.6** as primary executor
- **DeepSeek** as reasoning escalator
- **GPT-5.4** as verifier/repairer

This roadmap is prioritized for impact, not just completeness.

## Guiding principles

1. **Keep Qwen cheap and productive**
2. **Escalate only when the evidence says it helps**
3. **Use GPT-5.4 for correctness, not routine generation**
4. **Prefer structured handoffs over freeform text**
5. **Measure route quality, not just cost and latency**

## Phase 1: Short term (1-2 sprints)

## Sprint 1: Correctness and control-plane fixes

### Priority
P0

### Goals
Remove obvious orchestration and evaluation weaknesses.

### Work items

#### 1. Make policy decisions authoritative
- ensure orchestrator respects `deepseek` and `gpt54` selections
- stop treating policy as Qwen-only advisory input
- add explicit route outcome logging

#### 2. Fix Qwen metrics fidelity
- implement real cache hit counters
- track wall-clock batch latency
- track per-model retry counts and timeout rates

#### 3. Fix verifier decision thresholds
- split issues into blocking vs non-blocking
- allow approval when only low-severity polish issues remain
- keep `repair` for narrow actionable issues

#### 4. Strengthen intent validation
- require evidence from changed files, tests, or semantics
- do not treat "files changed" as sufficient intent fulfillment

#### 5. Introduce structured escalation packet
Create a standard object containing:
- task intent
- changed files
- failing tests/logs
- prior attempts
- current patch summary
- likely affected symbols
- budget remaining

### Success metrics
- cache hit ratio becomes measurable
- verifier false-reject rate reduced
- route audit logs show policy-selected model vs actual model
- repair loops per task decrease by at least 10%

## Sprint 2: Prompt and handoff upgrades

### Priority
P0 / P1

### Goals
Make each model better at its assigned job.

### Work items

#### 1. Add Qwen execution modes
- patch mode
- refactor mode
- test-fix mode
- batch transformation mode

#### 2. Add DeepSeek structured reasoning schema
- hypotheses
- evidence
- chosen plan
- risks
- retry hints

#### 3. Add GPT-5.4 blocking/non-blocking review schema
- blocking issues
- non-blocking issues
- repair instructions
- rationale

#### 4. Replace head/tail context trimming for code tasks
- prioritize failing tests, edit regions, symbols, call sites, types

### Success metrics
- first-pass verifier approval rate up by 10-15%
- lower average Qwen token usage for similar tasks
- DeepSeek repair plans produce better second-pass outcomes

## Phase 2: Medium term (1-3 months)

## Month 1: Dynamic routing intelligence

### Priority
P1

### Goals
Move from static rules to feedback-informed routing.

### Work items

#### 1. Introduce task risk scoring
Signals:
- file count
- context pressure
- failure history
- task type
- ambiguity level
- urgency
- known high-risk modules

#### 2. Add route quality tracking
Track by model + task type:
- verifier approval rate
- repair-loop count
- timeout rate
- cost per successful task
- average latency

#### 3. Feed quality metrics back into policy
- route by expected success-per-dollar
- deprioritize failing routes automatically
- raise DeepSeek planning frequency only where it pays off

#### 4. Add executor self-check score
Before verifier handoff, compute:
- syntax confidence
- import consistency
- caller/callee consistency
- change coverage
- assumption count

### Success metrics
- better route-model fit across task categories
- reduced unnecessary DeepSeek escalations
- reduced GPT-5.4 usage on easy tasks without hurting approval rate

## Month 2: Better multi-file coordination

### Priority
P1

### Goals
Improve behavior on refactors and larger tasks.

### Work items

#### 1. Create shared task plan across files
- plan dependencies before patch generation
- define edit order
- mark risky edges

#### 2. Add symbol-graph-aware context packing
- include definitions and call sites instead of large raw files

#### 3. Add consistency pass before verifier
- check renamed APIs across files
- check imports/exports after refactor
- check interface implementation drift

#### 4. Add regression-focused test selection
- pick most relevant tests per changed files/symbols
- run focused validation first

### Success metrics
- multi-file task approval rate improves materially
- fewer regressions found only at final verification
- lower token waste on large-context tasks

## Month 3: Repair loop quality

### Priority
P1 / P2

### Goals
Make failures cheaper and smarter to recover from.

### Work items

#### 1. Verifier-guided retry briefs
When GPT-5.4 rejects or requests repair, generate a structured retry brief for Qwen.

#### 2. DeepSeek repair-plan ranking
For ambiguous fixes, compare multiple repair options and pick the smallest safe one.

#### 3. Error-class-specific retry policies
Examples:
- syntax/type -> one cheap Qwen retry
- runtime/test ambiguity -> DeepSeek analysis first
- dependency conflict -> graph-aware repair path

#### 4. Add stop conditions
- maximum low-value retry count
- escalating uncertainty threshold
- budget-based stop/go gates

### Success metrics
- average attempts per failed task decrease
- second-attempt success rate improves
- wasted retries drop significantly

## Phase 3: Long term (3-6 months)

## Quarter roadmap themes

### Theme 1: Repository intelligence layer

Build a reusable repo understanding substrate:
- symbol graph
- dependency graph
- module ownership/risk scoring
- test coverage map
- API contract snapshots

### Theme 2: Semantic verification

Evolve GPT-5.4 verification beyond heuristics:
- AST-aware checks
- interface compatibility checks
- behavior-contract validation
- test-to-change adequacy scoring
- patch comparison/ranking

### Theme 3: Planner-executor-verifier closed loop

Target loop:
- plan
- execute
- self-check
- verify
- repair-plan
- constrained retry
- final verify

This is the real path to Opus-like behavior.

### Theme 4: Data-driven orchestration

Add offline/online evaluation harnesses:
- benchmark tasks by category
- compare route strategies
- compare prompt variants
- track verifier-human agreement
- optimize success-per-dollar

## Long-term initiatives

### Initiative A: Task archetype library
Create reusable workflows for:
- simple edit
- build fix
- test fix
- refactor
- API migration
- dependency repair
- regression repair

### Initiative B: Candidate patch generation and ranking
For high-risk tasks:
- let Qwen generate 2 candidates cheaply
- let GPT-5.4 rank or reject
- optionally use DeepSeek to explain tradeoffs

### Initiative C: Human-style review summaries
For major tasks, generate:
- what changed
- why it changed
- risk areas
- what remains uncertain

This will improve trust and debugging.

## Recommended milestone ordering

## Milestone 1
Control-plane integrity.

Must-have outcomes:
- authoritative routing
- sane verifier decisions
- structured escalation packets

## Milestone 2
Model specialization quality.

Must-have outcomes:
- task-specific prompts
- structured DeepSeek output
- stronger GPT verification brief

## Milestone 3
Feedback-informed routing.

Must-have outcomes:
- route quality metrics
- risk scoring
- expected-success-aware policy

## Milestone 4
Large-task competence.

Must-have outcomes:
- multi-file planning
- graph-aware context
- consistency pre-checks

## Milestone 5
Opus-like recovery loop.

Must-have outcomes:
- verifier-guided retries
- smarter repair planning
- lower cost per successful difficult task

## KPI dashboard

## Core quality metrics
- first-pass verifier approval rate
- final task success rate
- verifier-human agreement rate
- regression escape rate

## Recovery metrics
- average repair-loop count
- second-attempt success rate
- wasted retry rate

## Efficiency metrics
- cost per successful task
- tokens per successful task
- average latency per approved task
- DeepSeek escalation rate
- GPT-5.4 verification spend ratio

## Scale metrics
- multi-file success rate
- refactor success rate
- test-fix success rate
- batch task success rate

## Concrete target state

A healthy near-term target for JackCode is:

- **Qwen handles the majority of execution successfully**
- **DeepSeek is invoked selectively but meaningfully**
- **GPT-5.4 catches real issues without becoming a false-reject machine**
- **policy routing improves over time using outcome data**

That would already feel much closer to an Opus 4.6-style workflow than the current static, mostly component-level integration.

## Final recommendation

Do not try to jump straight to full autonomy. The highest-return sequence is:

1. fix routing/verifier correctness
2. improve prompts and handoffs
3. add feedback-driven policy
4. improve multi-file planning
5. refine repair loops

That order gives the best chance of materially improving quality without exploding cost or complexity.

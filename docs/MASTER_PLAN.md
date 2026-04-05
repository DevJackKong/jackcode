# JackCode Master Plan

## Goal
Build JackCode as an independent coding-agent framework with native JackClaw compatibility.

## Model roles
- Qwen 3.6: primary executor
- GPT-5.4: verifier / repairer
- GPT-5.4: verifier / repairer

## Parallel thread map
1. runtime-state-machine
2. session-context
3. patch-engine
4. build-test-loop
5. repo-scanner
6. symbol-import-index
7. impact-analyzer
8. context-compressor
9. qwen-executor-router
10. legacy-reasoner-router (historical, removed)
11. gpt54-verifier-repairer
12. model-policy-cost-control
13. jackclaw-node-adapter
14. jackclaw-memory-adapter
15. jackclaw-collaboration-adapter
16. cli-chat-ux
17. developer-workflow-ux
18. trace-observability
19. recovery-retry-safety
20. integration-qa

## Delivery rule
Each thread should only write its own assigned design/scaffold files and leave integration notes.

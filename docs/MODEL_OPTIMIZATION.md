# Model Optimization

## Final architecture

JackCode is optimized around two models only:

- **Developer:** Qwen 3.6
- **Auditor:** GPT-5.4

## Why this is simpler

- No DeepSeek escalation path
- No reasoning-router handoff overhead
- One default development model for all coding tasks
- One audit model for final verification

## Cost strategy

- Route nearly all implementation work to Qwen 3.6
- Reserve GPT-5.4 for verification and audit-heavy tasks
- Reduce context switching and policy complexity

## Policy summary

- `simple_edit`, `debug`, `refactor`, `build_fix`, `test_fix`, `batch_operation` → **Qwen**
- `final_verification` → **GPT-5.4**

## Config

```json
{
  "developer": "qwen-3.6",
  "auditor": "gpt-5.4"
}
```

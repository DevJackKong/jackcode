/**
 * Canonical model router entrypoint.
 *
 * Qwen 3.6 is the primary developer route for all coding work.
 * DeepSeek is used only as an escalation/specialist reasoning pass.
 * GPT-5.4 is reserved for verification and audit flows.
 *
 * This module intentionally re-exports the full Qwen router implementation so
 * older imports (`../model/router.js`) automatically use the Qwen-first stack.
 */

export {
  QwenExecutorRouter,
  qwenRouter,
  createQwenRouter,
  type QwenModelId,
  type QwenErrorType,
  type QwenMessage,
  type QwenToolDefinition,
  type QwenToolCall,
  type QwenPreparedRequest,
  type QwenProviderResponse,
  type QwenProvider,
  type PolicyAdapter,
  type TelemetryAdapter,
  type SpanLike,
  type TelemetryMetricsLike,
  type QwenRouterDependencies,
  type QwenRouterConfig,
  type ExtendedQwenRouteRequest,
} from './qwen-router.js';

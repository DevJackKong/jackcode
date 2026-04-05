/**
 * Canonical model router entrypoint.
 *
 * JackCode uses a simple two-model architecture:
 * - Qwen 3.6 for all development work
 * - GPT-5.4 for audit / verification flows
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

/**
 * Thread 10: DeepSeek Reasoner Router
 * Backward-compatible provider shim that re-exports the full router implementation.
 */

export {
  DeepSeekReasonerRouter,
  createDeepSeekRouter,
  deepseekRouter,
} from '../deepseek-router.js';

export type {
  DeepSeekErrorInfo,
  DeepSeekErrorType,
  DeepSeekExecutionOptions,
  DeepSeekExecutionResult,
  DeepSeekMessage,
  DeepSeekRouteDecision,
  DeepSeekRouterOptions,
  DeepSeekStreamChunk,
  DeepSeekToolCall,
  DeepSeekToolDefinition,
  DeepSeekTransport,
  DeepSeekTransportRequest,
  DeepSeekTransportResponse,
  EscalationAssessment,
} from '../deepseek-router.js';

export { DeepSeekReasonerRouter as default } from '../deepseek-router.js';

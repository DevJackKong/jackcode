/**
 * Canonical model router entrypoint.
 *
 * JackCode uses a simple two-model architecture:
 * - Qwen 3.6 for all development work
 * - GPT-5.4 for audit / verification flows
 */
export { QwenExecutorRouter, qwenRouter, createQwenRouter, } from './qwen-router.js';

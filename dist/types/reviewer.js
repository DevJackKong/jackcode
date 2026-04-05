/**
 * Thread 11: GPT-5.4 Verifier / Repairer Types
 * Type definitions for final verification and quality assurance
 */
/**
 * Default verifier configuration
 */
export const DEFAULT_VERIFIER_CONFIG = {
    model: 'gpt-5.4',
    maxVerificationTokens: 8192,
    temperature: 0.1,
    autoRepairThreshold: 3,
    enablePolishFixes: true,
    timeoutMs: 60000,
};

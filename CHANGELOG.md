# Changelog

All notable changes to this project will be documented in this file.

## [1.0.0] - 2026-04-05

### Added
- Interactive CLI with chat, one-shot, and execute modes
- Session persistence, export, load, and resume workflows
- Repository scanner for file discovery, language detection, and git metadata collection
- Context compression and relevance scoring for model context management
- Impact analyzer scaffolding for dependency-aware change analysis
- Patch engine and test runner foundations for safe code modification workflows
- Runtime, session, recovery, repair, and review orchestration modules
- Model routing and policy support for Qwen 3.6 and GPT-5.4
- JackClaw adapters for node, memory, collaboration, and task integration
- Documentation covering API surface, usage, architecture, and implementation threads

### Changed
- Simplified the architecture to a two-model system:
  - Qwen 3.6 for development and implementation
  - GPT-5.4 for audit and final verification
- Removed DeepSeek from the active routing architecture to reduce complexity and maintenance cost
- Prepared npm packaging with executable CLI entry point, MIT license, and release metadata

### Notes
- This 1.0.0 release represents the first npm-ready packaging pass for JackCode
- The architecture is intentionally simplified for maintainability and predictable model routing

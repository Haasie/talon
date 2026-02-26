/**
 * Structured logging via pino.
 *
 * Creates the root logger with base fields (run_id, version) and exports
 * helpers to derive child loggers scoped to a thread, persona, or tool call.
 * In development, pretty-prints via pino-pretty; in production emits JSON.
 */

export {};

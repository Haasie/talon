/**
 * Durable work queue.
 *
 * SQLite-backed FIFO queue with per-thread ordering, retry with exponential
 * backoff and jitter, configurable attempt cap, and a dead-letter queue for
 * exhausted items. Crash recovery restores in-flight items on startup.
 */

export {};

/**
 * Session tracker — SDK session ID persistence per conversation thread.
 *
 * The Claude Agent SDK assigns a session ID to each run. Passing that session
 * ID back in the next run allows the SDK to resume the conversation context
 * rather than starting fresh, enabling multi-turn conversations without
 * re-sending the full message history.
 *
 * SessionTracker is a lightweight in-memory store that maps threadId ->
 * sessionId. Entries are evicted after a configurable TTL (default 24h) to
 * prevent unbounded memory growth in long-running daemon processes.
 *
 * If the daemon restarts, sessions are forgotten and agents start fresh (the
 * conversation history can be reconstructed from the DB if needed by a future
 * enhancement).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default session TTL: 24 hours in milliseconds. */
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// SessionTracker
// ---------------------------------------------------------------------------

interface SessionEntry {
  sessionId: string;
  lastUsedAt: number;
}

/**
 * In-memory store for SDK session IDs keyed by thread ID.
 *
 * Thread-safety note: talond runs in a single Node.js event loop. There is no
 * concurrent access to this map so no locking is required.
 */
export class SessionTracker {
  private readonly sessions: Map<string, SessionEntry> = new Map();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Retrieve the session ID for a thread, if one has been recorded.
   *
   * Returns `undefined` when no session has been started for the thread (first
   * message), after `clearSession()` has been called, or if the entry has
   * expired.
   *
   * @param threadId - The thread identifier.
   * @returns The stored session ID, or `undefined`.
   */
  getSessionId(threadId: string): string | undefined {
    const entry = this.sessions.get(threadId);
    if (!entry) return undefined;

    if (this.isExpired(entry)) {
      this.sessions.delete(threadId);
      return undefined;
    }

    // Touch: update lastUsedAt on read.
    entry.lastUsedAt = Date.now();
    return entry.sessionId;
  }

  /**
   * Record (or overwrite) the session ID for a thread.
   *
   * Called after each successful agent run with the session ID returned by the
   * SDK so that the next run for the same thread can resume the conversation.
   *
   * @param threadId  - The thread identifier.
   * @param sessionId - The SDK session ID returned by the completed run.
   */
  setSessionId(threadId: string, sessionId: string): void {
    this.sessions.set(threadId, { sessionId, lastUsedAt: Date.now() });
  }

  /**
   * Remove the stored session ID for a thread.
   *
   * Call this when a thread's container is destroyed so that the next
   * dispatch creates a fresh session rather than attempting to resume a
   * session whose process no longer exists.
   *
   * @param threadId - The thread whose session should be cleared.
   */
  clearSession(threadId: string): void {
    this.sessions.delete(threadId);
  }

  /**
   * Remove all stored session IDs.
   *
   * Used during daemon shutdown or when all containers are evicted.
   */
  clearAll(): void {
    this.sessions.clear();
  }

  /**
   * Return the number of active (non-expired) sessions.
   *
   * Evicts stale entries first so the count reflects only live sessions.
   * Primarily useful for health checks and metrics.
   */
  size(): number {
    this.evictStale();
    return this.sessions.size;
  }

  /**
   * Check whether a session ID is stored for the given thread.
   *
   * @param threadId - The thread to check.
   * @returns `true` if a non-expired session ID is present.
   */
  hasSession(threadId: string): boolean {
    const entry = this.sessions.get(threadId);
    if (!entry) return false;

    if (this.isExpired(entry)) {
      this.sessions.delete(threadId);
      return false;
    }

    return true;
  }

  /**
   * Evict all sessions that have not been used within the TTL window.
   *
   * Returns the number of entries evicted. Call this periodically (e.g. on
   * scheduler ticks) to bound memory usage.
   */
  evictStale(): number {
    let evicted = 0;
    for (const [threadId, entry] of this.sessions) {
      if (this.isExpired(entry)) {
        this.sessions.delete(threadId);
        evicted++;
      }
    }
    return evicted;
  }

  private isExpired(entry: SessionEntry): boolean {
    return Date.now() - entry.lastUsedAt > this.ttlMs;
  }
}

/**
 * Session tracker — SDK session ID persistence per conversation thread.
 *
 * The Claude Agent SDK assigns a session ID to each run. Passing that session
 * ID back in the next run allows the SDK to resume the conversation context
 * rather than starting fresh, enabling multi-turn conversations without
 * re-sending the full message history.
 *
 * SessionTracker is a lightweight in-memory store that maps threadId ->
 * sessionId.  It is intentionally simple: no TTL, no serialisation.  If the
 * daemon restarts, sessions are forgotten and agents start fresh (the
 * conversation history can be reconstructed from the DB if needed by a future
 * enhancement).
 */

// ---------------------------------------------------------------------------
// SessionTracker
// ---------------------------------------------------------------------------

/**
 * In-memory store for SDK session IDs keyed by thread ID.
 *
 * Thread-safety note: talond runs in a single Node.js event loop. There is no
 * concurrent access to this map so no locking is required.
 */
export class SessionTracker {
  private readonly sessions: Map<string, string> = new Map();

  /**
   * Retrieve the session ID for a thread, if one has been recorded.
   *
   * Returns `undefined` when no session has been started for the thread (first
   * message) or after `clearSession()` has been called.
   *
   * @param threadId - The thread identifier.
   * @returns The stored session ID, or `undefined`.
   */
  getSessionId(threadId: string): string | undefined {
    return this.sessions.get(threadId);
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
    this.sessions.set(threadId, sessionId);
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
   * Return the number of active sessions.
   *
   * Primarily useful for health checks and metrics.
   */
  size(): number {
    return this.sessions.size;
  }

  /**
   * Check whether a session ID is stored for the given thread.
   *
   * @param threadId - The thread to check.
   * @returns `true` if a session ID is present.
   */
  hasSession(threadId: string): boolean {
    return this.sessions.has(threadId);
  }
}

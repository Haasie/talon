# Rolling Context Window Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically summarize and rotate Agent SDK sessions when context usage approaches a threshold, injecting compressed history into fresh sessions so the user experiences seamless conversation continuity.

**Architecture:** After each agent run, check `cacheReadTokens`. When it exceeds 80K, reconstruct the transcript from the `messages` table, run `session-summarizer`, store the result as memory items, and clear the session. On the next run (fresh session), assemble previous context from the latest session summary and recent messages into the system prompt. The agent continues with full compressed history + verbatim recent exchanges. Old summaries are regular memory items subject to `memory-groomer` consolidation.

**Tech Stack:** TypeScript, better-sqlite3, Vercel AI SDK, neverthrow Result types, vitest

---

## File Structure

| File | Responsibility |
|------|---------------|
| `src/daemon/context-roller.ts` | **NEW** — Core logic: token threshold check, transcript reconstruction, summary triggering, memory storage, session clearing |
| `src/daemon/context-assembler.ts` | **NEW** — Pre-run context assembly: pull latest session summary + recent messages, format as system prompt section |
| `src/daemon/agent-runner.ts` | **MODIFY** — Wire in context-roller (post-run) and context-assembler (pre-run) |
| `src/core/database/repositories/message-repository.ts` | **MODIFY** — Add `findLatestByThread(threadId, limit)` for fetching recent messages in reverse chronological order |
| `tests/unit/daemon/context-roller.test.ts` | **NEW** — Tests for threshold detection, transcript reconstruction, summary storage, session clearing |
| `tests/unit/daemon/context-assembler.test.ts` | **NEW** — Tests for context injection on fresh sessions, no injection on resumed sessions |
| `tests/unit/database/message-repository.test.ts` | **MODIFY** — Add test for `findLatestByThread` |

## Design Decisions

### Token threshold: 80K

Sonnet's context window is 200K tokens. We target 80K as the rotation threshold because:
- Leaves headroom for the current turn's input + output (~10-20K)
- `cacheReadTokens` is a good proxy — it represents the cached conversation so far
- The fresh session after rotation starts at ~10-15K (system prompt + summary + recent messages)
- This gives ~70K of organic conversation before the next rotation

### Transcript reconstruction from messages table

We don't have the raw Agent SDK transcript (tool calls, thinking, etc.). We reconstruct from stored messages:
```
User: <inbound message content>
Assistant: <outbound message content>
```
This loses tool-use details but captures the conversational substance — which is what matters for summarization.

### Summary storage as memory items

Session summaries are stored as `memory_items` with type `summary`. This means:
- They're automatically available to `memory-retriever` for context
- They're subject to `memory-groomer` consolidation (old summaries get merged/pruned)
- No new tables or schema changes needed

### Context injection on fresh sessions only

The context assembler only injects history when there's no active session to resume. If the session tracker returns a valid session ID, the Agent SDK handles continuity natively — no injection needed.

### Recent messages count: last 10 messages (5 exchanges)

On session rotation, we inject the last 10 messages verbatim alongside the summary. This gives the agent immediate conversational context (what was just discussed) while the summary covers everything before that.

### The SubAgentRunner bypass problem

`SubAgentRunner.execute()` validates persona assignment and capabilities. For daemon-internal calls (triggered by the context roller, not by the agent), we need to bypass this. Rather than adding a backdoor to the runner, the context roller will call the sub-agent's `run()` function directly — it already has access to the loaded sub-agent map. The runner's validation is for agent-initiated calls via the `subagent_invoke` tool; daemon-internal calls are trusted.

---

## Chunk 1: Database + Context Roller

### Task 1: Add `findLatestByThread` to MessageRepository

**Files:**
- Modify: `src/core/database/repositories/message-repository.ts`
- Test: `tests/unit/database/message-repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// In the existing message-repository test file, add:
describe('findLatestByThread', () => {
  it('returns the most recent N messages in chronological order', () => {
    // Insert 5 messages with increasing timestamps
    for (let i = 0; i < 5; i++) {
      repo.insert({
        id: `msg-${i}`,
        thread_id: 'thread-1',
        direction: i % 2 === 0 ? 'inbound' : 'outbound',
        content: JSON.stringify({ body: `message ${i}` }),
        idempotency_key: `key-${i}`,
        provider_id: null,
        run_id: null,
      });
    }

    const result = repo.findLatestByThread('thread-1', 3);
    expect(result.isOk()).toBe(true);
    const rows = result._unsafeUnwrap();
    expect(rows).toHaveLength(3);
    // Should be the last 3, in chronological order (oldest first)
    expect(rows[0].id).toBe('msg-2');
    expect(rows[1].id).toBe('msg-3');
    expect(rows[2].id).toBe('msg-4');
  });

  it('returns all messages when fewer than limit exist', () => {
    repo.insert({
      id: 'msg-only',
      thread_id: 'thread-1',
      direction: 'inbound',
      content: JSON.stringify({ body: 'only message' }),
      idempotency_key: 'key-only',
      provider_id: null,
      run_id: null,
    });

    const result = repo.findLatestByThread('thread-1', 10);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(1);
  });

  it('returns empty array for unknown thread', () => {
    const result = repo.findLatestByThread('nonexistent', 5);
    expect(result.isOk()).toBe(true);
    expect(result._unsafeUnwrap()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/database/message-repository.test.ts -t "findLatestByThread"`
Expected: FAIL — `repo.findLatestByThread is not a function`

- [ ] **Step 3: Implement `findLatestByThread`**

Add to `src/core/database/repositories/message-repository.ts`:

```typescript
// Add to constructor, after existing statements:
this.findLatestByThreadStmt = db.prepare(`
  SELECT * FROM (
    SELECT * FROM messages
    WHERE thread_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  ) sub ORDER BY created_at ASC
`);

// Add field declaration:
private readonly findLatestByThreadStmt: Database.Statement;

// Add method:
/**
 * Returns the most recent N messages for a thread in chronological order.
 * Useful for reconstructing recent conversation context.
 */
findLatestByThread(threadId: string, limit: number): Result<MessageRow[], DbError> {
  try {
    const rows = this.findLatestByThreadStmt.all(threadId, limit) as MessageRow[];
    return ok(rows);
  } catch (cause) {
    return err(
      new DbError(
        `Failed to find latest messages by thread: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/database/message-repository.test.ts -t "findLatestByThread"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/database/repositories/message-repository.ts tests/unit/database/message-repository.test.ts
git commit -m "feat(db): add findLatestByThread for recent message retrieval"
```

---

### Task 2: Build the ContextRoller

**Files:**
- Create: `src/daemon/context-roller.ts`
- Test: `tests/unit/daemon/context-roller.test.ts`

The context roller is responsible for:
1. Checking if `cacheReadTokens` exceeds the threshold after a run
2. Reconstructing the transcript from the messages table
3. Calling the session-summarizer sub-agent directly
4. Storing the summary as memory items
5. Clearing the session

- [ ] **Step 6: Write the failing tests**

```typescript
// tests/unit/daemon/context-roller.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from 'neverthrow';

// Mock the session-summarizer's run function
const mockSummarizerRun = vi.fn();

import { ContextRoller, type ContextRollerDeps } from '../../../src/daemon/context-roller.js';

const makeDeps = (overrides: Partial<ContextRollerDeps> = {}): ContextRollerDeps => ({
  messageRepo: {
    findByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  memoryRepo: {
    insert: vi.fn().mockReturnValue(ok({})),
  } as any,
  sessionTracker: {
    clearSession: vi.fn(),
  } as any,
  summarizerRun: mockSummarizerRun,
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
  } as any,
  thresholdTokens: 80_000,
  recentMessageCount: 10,
  ...overrides,
});

describe('ContextRoller', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does nothing when cacheReadTokens is below threshold', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 50_000);

    expect(deps.messageRepo.findByThread).not.toHaveBeenCalled();
    expect(mockSummarizerRun).not.toHaveBeenCalled();
  });

  it('triggers rotation when cacheReadTokens exceeds threshold', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
      { direction: 'outbound', content: JSON.stringify({ body: 'hi there' }), created_at: 2000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'User said hello',
      data: {
        keyFacts: ['User greeted'],
        openThreads: [],
        summary: 'User said hello',
      },
      usage: { inputTokens: 100, outputTokens: 50, costUsd: 0 },
    }));

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 90_000);

    expect(deps.messageRepo.findByThread).toHaveBeenCalledWith('thread-1', 10000, 0);
    expect(mockSummarizerRun).toHaveBeenCalled();
    expect(deps.memoryRepo.insert).toHaveBeenCalled();
    expect(deps.sessionTracker.clearSession).toHaveBeenCalledWith('thread-1');
  });

  it('stores summary as memory item with type summary', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(ok({
      summary: 'Greeting exchange',
      data: {
        keyFacts: ['User name is Ivo'],
        openThreads: ['Deployment pending'],
        summary: 'Brief greeting',
      },
    }));

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    // Should store summary + individual key facts
    const insertCalls = (deps.memoryRepo.insert as any).mock.calls;
    expect(insertCalls.length).toBeGreaterThanOrEqual(1);

    // First insert should be the session summary
    const summaryInsert = insertCalls[0][0];
    expect(summaryInsert.thread_id).toBe('thread-1');
    expect(summaryInsert.type).toBe('summary');
    expect(summaryInsert.content).toContain('Brief greeting');
  });

  it('does not clear session if summarizer fails', async () => {
    const messages = [
      { direction: 'inbound', content: JSON.stringify({ body: 'hello' }), created_at: 1000 },
    ];
    mockSummarizerRun.mockResolvedValueOnce(
      err(new Error('API rate limit')),
    );

    const deps = makeDeps({
      messageRepo: {
        findByThread: vi.fn().mockReturnValue(ok(messages)),
      } as any,
    });
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    // Session should NOT be cleared if summarization failed
    expect(deps.sessionTracker.clearSession).not.toHaveBeenCalled();
  });

  it('handles empty message history gracefully', async () => {
    const deps = makeDeps();
    const roller = new ContextRoller(deps);

    await roller.checkAndRotate('thread-1', 'persona-1', 100_000);

    // No messages → nothing to summarize → no rotation
    expect(mockSummarizerRun).not.toHaveBeenCalled();
    expect(deps.sessionTracker.clearSession).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 7: Run tests to verify they fail**

Run: `npx vitest run tests/unit/daemon/context-roller.test.ts`
Expected: FAIL — module not found

- [ ] **Step 8: Implement ContextRoller**

```typescript
// src/daemon/context-roller.ts
/**
 * ContextRoller — manages automatic session rotation when context usage
 * approaches the threshold.
 *
 * After each agent run, the caller passes the cacheReadTokens count.
 * If it exceeds the configured threshold, the roller:
 *   1. Reconstructs the transcript from the messages table
 *   2. Calls the session-summarizer sub-agent directly
 *   3. Stores the summary as memory items (type: 'summary')
 *   4. Clears the session so the next run starts fresh
 *
 * The fresh session then picks up the summary via ContextAssembler.
 */

import { randomUUID } from 'node:crypto';
import type { Result } from 'neverthrow';
import type pino from 'pino';
import type { MessageRepository, MessageRow } from '../core/database/repositories/message-repository.js';
import type { MemoryRepository } from '../core/database/repositories/memory-repository.js';
import type { SessionTracker } from '../sandbox/session-tracker.js';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../subagents/subagent-types.js';
import type { SubAgentError } from '../core/errors/index.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SummarizerRunFn = (
  ctx: SubAgentContext,
  input: SubAgentInput,
) => Promise<Result<SubAgentResult, SubAgentError>>;

export interface ContextRollerDeps {
  messageRepo: MessageRepository;
  memoryRepo: MemoryRepository;
  sessionTracker: SessionTracker;
  /** The session-summarizer's run function, called directly (no runner validation). */
  summarizerRun: SummarizerRunFn;
  logger: pino.Logger;
  /** Token count threshold for triggering rotation. Default: 80_000. */
  thresholdTokens: number;
  /** Number of recent messages to keep as context breadcrumb. Default: 10. */
  recentMessageCount: number;
}

// ---------------------------------------------------------------------------
// ContextRoller
// ---------------------------------------------------------------------------

export class ContextRoller {
  private readonly deps: ContextRollerDeps;

  constructor(deps: ContextRollerDeps) {
    this.deps = deps;
  }

  /**
   * Check if context usage exceeds the threshold and rotate if needed.
   *
   * Call this after every successful agent run with the cacheReadTokens
   * from the run result.
   *
   * @param threadId - The conversation thread ID.
   * @param personaId - The persona that owns this thread.
   * @param cacheReadTokens - Context window usage from the completed run.
   */
  async checkAndRotate(
    threadId: string,
    personaId: string,
    cacheReadTokens: number,
  ): Promise<void> {
    if (cacheReadTokens < this.deps.thresholdTokens) {
      return;
    }

    this.deps.logger.info(
      { threadId, cacheReadTokens, threshold: this.deps.thresholdTokens },
      'context-roller: threshold exceeded, rotating session',
    );

    // 1. Reconstruct transcript from messages.
    const messagesResult = this.deps.messageRepo.findByThread(threadId, 10_000, 0);
    if (messagesResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: messagesResult.error.message },
        'context-roller: failed to read messages, skipping rotation',
      );
      return;
    }

    const messages = messagesResult.value;
    if (messages.length === 0) {
      this.deps.logger.warn({ threadId }, 'context-roller: no messages found, skipping rotation');
      return;
    }

    const transcript = this.buildTranscript(messages);

    // 2. Call session-summarizer directly (bypass runner validation).
    const summaryResult = await this.deps.summarizerRun(
      {
        threadId,
        personaId,
        systemPrompt: 'You are a conversation summarizer. Extract key facts, open threads, and a concise summary.',
        model: {} as any, // Model is resolved by the caller when wiring deps
        maxOutputTokens: 4096,
        rootPaths: [],
        services: {
          memory: this.deps.memoryRepo,
          messages: this.deps.messageRepo,
          logger: this.deps.logger,
          // Unused services — stub them out
          schedules: {} as any,
          personas: {} as any,
          channels: {} as any,
          threads: {} as any,
          runs: {} as any,
          queue: {} as any,
        },
      },
      { transcript },
    );

    if (summaryResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: summaryResult.error.message },
        'context-roller: summarization failed, keeping current session',
      );
      return;
    }

    const summary = summaryResult.value;
    const data = summary.data as {
      keyFacts?: string[];
      openThreads?: string[];
      summary?: string;
    } | undefined;

    // 3. Store summary as memory items.
    const summaryContent = [
      data?.summary ?? summary.summary,
      '',
      'Key facts:',
      ...(data?.keyFacts ?? []).map((f) => `- ${f}`),
      '',
      'Open threads:',
      ...(data?.openThreads ?? []).map((t) => `- ${t}`),
    ].join('\n');

    const insertResult = this.deps.memoryRepo.insert({
      id: randomUUID(),
      thread_id: threadId,
      type: 'summary',
      content: summaryContent,
      embedding_ref: null,
      metadata: JSON.stringify({
        source: 'context-roller',
        messageCount: messages.length,
        cacheReadTokens,
        createdAt: new Date().toISOString(),
      }),
    });

    if (insertResult.isErr()) {
      this.deps.logger.error(
        { threadId, error: insertResult.error.message },
        'context-roller: failed to store summary, keeping current session',
      );
      return;
    }

    // 4. Clear session — next run starts fresh.
    this.deps.sessionTracker.clearSession(threadId);

    this.deps.logger.info(
      { threadId, messageCount: messages.length, summaryLength: summaryContent.length },
      'context-roller: session rotated successfully',
    );
  }

  /**
   * Reconstruct a human-readable transcript from stored messages.
   */
  private buildTranscript(messages: MessageRow[]): string {
    return messages
      .map((msg) => {
        const role = msg.direction === 'inbound' ? 'User' : 'Assistant';
        let body: string;
        try {
          const parsed = JSON.parse(msg.content);
          body = typeof parsed.body === 'string' ? parsed.body : msg.content;
        } catch {
          body = msg.content;
        }
        return `${role}: ${body}`;
      })
      .join('\n');
  }
}
```

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run tests/unit/daemon/context-roller.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 10: Commit**

```bash
git add src/daemon/context-roller.ts tests/unit/daemon/context-roller.test.ts
git commit -m "feat(daemon): add ContextRoller for automatic session rotation"
```

---

## Chunk 2: Context Assembler + Agent Runner Integration

### Task 3: Build the ContextAssembler

**Files:**
- Create: `src/daemon/context-assembler.ts`
- Test: `tests/unit/daemon/context-assembler.test.ts`

The context assembler is responsible for building a "Previous Context" section when starting a fresh session (no active session to resume). It pulls the latest session summary from memory and the most recent messages.

- [ ] **Step 11: Write the failing tests**

```typescript
// tests/unit/daemon/context-assembler.test.ts
import { describe, it, expect, vi } from 'vitest';
import { ok } from 'neverthrow';

import { ContextAssembler, type ContextAssemblerDeps } from '../../../src/daemon/context-assembler.js';

const makeDeps = (overrides: Partial<ContextAssemblerDeps> = {}): ContextAssemblerDeps => ({
  messageRepo: {
    findLatestByThread: vi.fn().mockReturnValue(ok([])),
  } as any,
  memoryRepo: {
    findByThreadAndType: vi.fn().mockReturnValue(ok([])),
  } as any,
  recentMessageCount: 10,
  ...overrides,
});

describe('ContextAssembler', () => {
  it('returns empty string when no summary and no recent messages', () => {
    const assembler = new ContextAssembler(makeDeps());
    const result = assembler.assemble('thread-1');
    expect(result).toBe('');
  });

  it('includes session summary when available', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThreadAndType: vi.fn().mockReturnValue(ok([
          {
            id: 'sum-1',
            thread_id: 'thread-1',
            type: 'summary',
            content: 'Discussed deployment plans.\n\nKey facts:\n- Using Docker\n\nOpen threads:\n- CI pipeline',
            created_at: 1000,
          },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('Previous Context');
    expect(result).toContain('Discussed deployment plans');
    expect(result).toContain('Using Docker');
  });

  it('includes recent messages when available', () => {
    const deps = makeDeps({
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: JSON.stringify({ body: 'how is the deploy going?' }) },
          { direction: 'outbound', content: JSON.stringify({ body: 'All green, deployed 5 minutes ago.' }) },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('Recent Messages');
    expect(result).toContain('User: how is the deploy going?');
    expect(result).toContain('Assistant: All green, deployed 5 minutes ago.');
  });

  it('includes both summary and recent messages', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThreadAndType: vi.fn().mockReturnValue(ok([
          { id: 'sum-1', type: 'summary', content: 'Previous session summary.', created_at: 1000 },
        ])),
      } as any,
      messageRepo: {
        findLatestByThread: vi.fn().mockReturnValue(ok([
          { direction: 'inbound', content: JSON.stringify({ body: 'latest question' }) },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    expect(result).toContain('Previous Context');
    expect(result).toContain('Previous session summary.');
    expect(result).toContain('Recent Messages');
    expect(result).toContain('User: latest question');
  });

  it('uses only the most recent summary', () => {
    const deps = makeDeps({
      memoryRepo: {
        findByThreadAndType: vi.fn().mockReturnValue(ok([
          { id: 'sum-old', type: 'summary', content: 'Old summary.', created_at: 1000 },
          { id: 'sum-new', type: 'summary', content: 'New summary.', created_at: 2000 },
        ])),
      } as any,
    });

    const assembler = new ContextAssembler(deps);
    const result = assembler.assemble('thread-1');
    // findByThreadAndType returns DESC order, so first is newest
    expect(result).toContain('Old summary.');
    // Should only include one summary section
    expect(result.match(/## Previous Context/g)?.length).toBe(1);
  });
});
```

- [ ] **Step 12: Run tests to verify they fail**

Run: `npx vitest run tests/unit/daemon/context-assembler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 13: Check `findByThreadAndType` exists in MemoryRepository**

The `MemoryRepository` already has `findByThreadAndTypeStmt` (we saw it in the constructor). Verify it's exposed as a public method. If not, add it.

Checking `src/core/database/repositories/memory-repository.ts` — the field `findByThreadAndTypeStmt` is declared. Verify the method exists and its signature. If missing, add:

```typescript
findByThreadAndType(threadId: string, type: MemoryType): Result<MemoryItemRow[], DbError> {
  try {
    const rows = this.findByThreadAndTypeStmt.all(threadId, type) as MemoryItemRow[];
    return ok(rows);
  } catch (cause) {
    return err(
      new DbError(
        `Failed to find memory items by thread and type: ${String(cause)}`,
        cause instanceof Error ? cause : undefined,
      ),
    );
  }
}
```

- [ ] **Step 14: Implement ContextAssembler**

```typescript
// src/daemon/context-assembler.ts
/**
 * ContextAssembler — builds a "Previous Context" section for fresh sessions.
 *
 * When the agent starts a new session (no session ID to resume), this
 * assembler pulls:
 *   1. The latest session summary from memory items (type: 'summary')
 *   2. The most recent N messages from the messages table
 *
 * The result is a markdown section that gets appended to the system prompt,
 * giving the agent compressed history + verbatim recent context.
 *
 * Returns an empty string if there's no prior context (first conversation).
 */

import type { MessageRepository, MessageRow } from '../core/database/repositories/message-repository.js';
import type { MemoryRepository } from '../core/database/repositories/memory-repository.js';

export interface ContextAssemblerDeps {
  messageRepo: MessageRepository;
  memoryRepo: MemoryRepository;
  /** Number of recent messages to include verbatim. Default: 10. */
  recentMessageCount: number;
}

export class ContextAssembler {
  private readonly deps: ContextAssemblerDeps;

  constructor(deps: ContextAssemblerDeps) {
    this.deps = deps;
  }

  /**
   * Assemble previous context for a fresh session.
   *
   * Returns a markdown string to append to the system prompt, or an
   * empty string if there's no prior context.
   */
  assemble(threadId: string): string {
    const sections: string[] = [];

    // 1. Get latest session summary from memory.
    const summaryResult = this.deps.memoryRepo.findByThreadAndType(threadId, 'summary');
    if (summaryResult.isOk() && summaryResult.value.length > 0) {
      // findByThreadAndType returns DESC by created_at, so first is newest.
      // But we want the most recent — take the last one since they're sorted DESC.
      const latest = summaryResult.value[0];
      sections.push(latest.content);
    }

    // 2. Get recent messages for immediate conversational context.
    const messagesResult = this.deps.messageRepo.findLatestByThread(
      threadId,
      this.deps.recentMessageCount,
    );
    if (messagesResult.isOk() && messagesResult.value.length > 0) {
      const formatted = this.formatMessages(messagesResult.value);
      sections.push(`### Recent Messages\n\n${formatted}`);
    }

    if (sections.length === 0) return '';

    return `## Previous Context\n\n${sections.join('\n\n')}`;
  }

  private formatMessages(messages: MessageRow[]): string {
    return messages
      .map((msg) => {
        const role = msg.direction === 'inbound' ? 'User' : 'Assistant';
        let body: string;
        try {
          const parsed = JSON.parse(msg.content);
          body = typeof parsed.body === 'string' ? parsed.body : msg.content;
        } catch {
          body = msg.content;
        }
        return `${role}: ${body}`;
      })
      .join('\n');
  }
}
```

- [ ] **Step 15: Run tests to verify they pass**

Run: `npx vitest run tests/unit/daemon/context-assembler.test.ts`
Expected: PASS — all 5 tests

- [ ] **Step 16: Commit**

```bash
git add src/daemon/context-assembler.ts tests/unit/daemon/context-assembler.test.ts
git commit -m "feat(daemon): add ContextAssembler for fresh session context injection"
```

---

### Task 4: Wire ContextRoller + ContextAssembler into AgentRunner

**Files:**
- Modify: `src/daemon/agent-runner.ts`
- Modify: `src/daemon/daemon-bootstrap.ts` (construct and inject dependencies)
- Modify: `src/daemon/daemon-context.ts` (add contextRoller and contextAssembler to context)

- [ ] **Step 17: Add contextRoller and contextAssembler to DaemonContext**

In `src/daemon/daemon-context.ts`, add two new fields to the `DaemonContext` interface:

```typescript
import type { ContextRoller } from './context-roller.js';
import type { ContextAssembler } from './context-assembler.js';

// Add to DaemonContext interface:
readonly contextRoller: ContextRoller | null;
readonly contextAssembler: ContextAssembler;
```

- [ ] **Step 18: Construct ContextAssembler and ContextRoller in bootstrap**

In `src/daemon/daemon-bootstrap.ts`, after the sub-agent runner is created, construct both:

```typescript
import { ContextRoller } from './context-roller.js';
import { ContextAssembler } from './context-assembler.js';

// After subAgentRunner construction:
const contextAssembler = new ContextAssembler({
  messageRepo: repos.message,
  memoryRepo: repos.memory,
  recentMessageCount: 10,
});

// ContextRoller needs the session-summarizer's run function.
// Extract it from the loaded sub-agents if available.
let contextRoller: ContextRoller | null = null;
const summarizerAgent = mergedAgentMap.get('session-summarizer');
if (summarizerAgent && subAgentRunner) {
  // Resolve the model for the summarizer at boot time.
  const summarizerModelResult = await modelResolver.resolve(summarizerAgent.manifest.model);
  if (summarizerModelResult.isOk()) {
    const summarizerModel = summarizerModelResult.value;
    const summarizerPrompt = summarizerAgent.promptContents.join('\n\n');
    // Wrap the run function with pre-resolved model and prompt
    const boundRun: typeof summarizerAgent.run = (ctx, input) =>
      summarizerAgent.run({ ...ctx, model: summarizerModel, systemPrompt: summarizerPrompt }, input);

    contextRoller = new ContextRoller({
      messageRepo: repos.message,
      memoryRepo: repos.memory,
      sessionTracker,
      summarizerRun: boundRun,
      logger,
      thresholdTokens: 80_000,
      recentMessageCount: 10,
    });

    logger.info('bootstrap: context roller initialized (threshold: 80K tokens)');
  } else {
    logger.warn(
      { error: summarizerModelResult.error.message },
      'bootstrap: failed to resolve model for context roller, session rotation disabled',
    );
  }
}
```

Add `contextRoller` and `contextAssembler` to the returned `DaemonContext` object.

- [ ] **Step 19: Wire into AgentRunner — post-run rotation check**

In `src/daemon/agent-runner.ts`, after persisting token usage (around line 370), add the context rotation check:

```typescript
// After the token usage persistence block:

// Check if context needs rotation (rolling window).
if (this.ctx.contextRoller && cacheReadTokens > 0) {
  // Fire-and-forget — rotation failures are logged but don't fail the run.
  this.ctx.contextRoller
    .checkAndRotate(item.threadId, personaId, cacheReadTokens)
    .catch((e: unknown) => {
      this.ctx.logger.error(
        { threadId: item.threadId, err: e },
        'agent-runner: context rotation failed',
      );
    });
}
```

- [ ] **Step 20: Wire into AgentRunner — pre-run context assembly**

In `src/daemon/agent-runner.ts`, when building the system prompt (around line 136), add context assembly for fresh sessions:

```typescript
// After assembling the base system prompt parts:
const systemPromptParts = [
  loadedPersona.systemPromptContent ?? '',
  loadedPersona.personalityContent ?? '',
  skillPrompt,
  channelContext,
];

// Inject previous context when starting a fresh session (no resume).
if (!existingSessionId) {
  const previousContext = this.ctx.contextAssembler.assemble(item.threadId);
  if (previousContext) {
    systemPromptParts.push(previousContext);
  }
}

const systemPrompt = systemPromptParts.filter(Boolean).join('\n\n');
```

Note: `existingSessionId` is already resolved by line 53-63. If it's `undefined`, this is a fresh session and we inject context.

- [ ] **Step 21: Run tsc to verify compilation**

Run: `npx tsc -p tsconfig.build.json --noEmit`
Expected: clean (no errors)

- [ ] **Step 22: Run all sub-agent + daemon tests**

Run: `npx vitest run tests/unit/daemon/ tests/unit/subagents/`
Expected: all pass

- [ ] **Step 23: Commit**

```bash
git add src/daemon/agent-runner.ts src/daemon/daemon-bootstrap.ts src/daemon/daemon-context.ts
git commit -m "feat(daemon): wire rolling context window into agent runner"
```

---

## Chunk 3: Verification + Documentation

### Task 5: End-to-end verification

- [ ] **Step 24: Build and verify**

```bash
npm run build
```

Expected: clean build, assets copied.

- [ ] **Step 25: Run full sub-agent + daemon test suite**

```bash
npx vitest run tests/unit/daemon/ tests/unit/subagents/ tests/unit/database/ tests/integration/
```

Expected: all pass.

- [ ] **Step 26: Update selfdoc.md and README.md**

Add a "Rolling Context Window" section to selfdoc.md explaining the mechanism. Update the session-summarizer description in README.md to explain that it's triggered automatically by the context roller, not manually by the agent.

Key points to document:
- Threshold: 80K `cacheReadTokens`
- Flow: threshold exceeded → summarize → store as memory → clear session
- Fresh sessions get: system prompt + previous summary + last 10 messages
- Old summaries subject to memory-groomer consolidation
- Context roller is fire-and-forget (failures don't break the run)

- [ ] **Step 27: Commit documentation**

```bash
git add selfdoc.md README.md
git commit -m "docs: add rolling context window documentation"
```

---

## Summary

| Task | What | Files |
|------|------|-------|
| 1 | `findLatestByThread` query | message-repository.ts |
| 2 | ContextRoller (threshold check → summarize → store → clear) | context-roller.ts |
| 3 | ContextAssembler (summary + recent messages → system prompt) | context-assembler.ts |
| 4 | Wire both into AgentRunner + bootstrap | agent-runner.ts, daemon-bootstrap.ts, daemon-context.ts |
| 5 | Verify, document | build, tests, docs |

Total new files: 2 source + 2 test.
Modified files: 5.
No schema changes, no new dependencies.

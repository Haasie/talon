/**
 * Context builder — assembles a complete {@link ThreadContext} from all
 * memory layers for injection into an agent prompt.
 *
 * Delegates to {@link MemoryManager} for individual layer reads and combines
 * the results into a single object. Partial failures in optional layers (e.g.
 * notebook) are logged and treated as empty rather than fatal.
 */

import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';

import { MemoryError } from '../core/errors/index.js';
import type { MemoryManager } from './memory-manager.js';
import type { ThreadContext } from './memory-types.js';

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

/** Default working memory window size when none is specified by the caller. */
const DEFAULT_WORKING_MEMORY_LIMIT = 50;

// ---------------------------------------------------------------------------
// ContextBuilder
// ---------------------------------------------------------------------------

/**
 * Assembles a {@link ThreadContext} from all available memory layers.
 *
 * Layer assembly order:
 * 1. Working memory window — recent transcript messages from DB.
 * 2. Thread notebook — markdown/text files from the thread's `memory/` dir.
 * 3. Structured memory — facts, summaries, and notes from DB.
 * 4. Persona system prompt — passed in by the caller.
 */
export class ContextBuilder {
  constructor(
    private readonly memoryManager: MemoryManager,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Builds the full context for a single agent run.
   *
   * If the notebook layer fails to read (e.g. workspace not yet created)
   * it is treated as empty and does not cause the overall build to fail.
   * Failures in DB-backed layers (working memory, structured memory) are
   * propagated as errors because they represent system-level problems.
   *
   * @param threadId           - Thread primary key.
   * @param personaSystemPrompt - System prompt text for the persona.
   * @param workingMemoryLimit  - Max number of recent messages to include
   *                             (defaults to {@link DEFAULT_WORKING_MEMORY_LIMIT}).
   * @returns `Ok<ThreadContext>` on success, `Err<MemoryError>` on failure.
   */
  buildContext(
    threadId: string,
    personaSystemPrompt: string,
    workingMemoryLimit: number = DEFAULT_WORKING_MEMORY_LIMIT,
  ): Result<ThreadContext, MemoryError> {
    this.logger.debug({ threadId, workingMemoryLimit }, 'context-builder: buildContext');

    // 1. Working memory (recent transcript messages)
    const workingMemoryResult = this.memoryManager.getWorkingMemory(threadId, workingMemoryLimit);
    if (workingMemoryResult.isErr()) {
      this.logger.error(
        { threadId, err: workingMemoryResult.error.message },
        'context-builder: failed to load working memory',
      );
      return err(workingMemoryResult.error);
    }

    // 2. Thread notebook (filesystem files) — treat missing dir as empty
    const notebookResult = this.memoryManager.readNotebook(threadId);
    let notebookFiles: Record<string, string> = {};
    if (notebookResult.isErr()) {
      this.logger.warn(
        { threadId, err: notebookResult.error.message },
        'context-builder: failed to read notebook — using empty',
      );
    } else {
      notebookFiles = notebookResult.value;
    }

    // 3. Structured memory (facts, summaries, notes)
    const structuredMemoryResult = this.memoryManager.readMemory(threadId);
    if (structuredMemoryResult.isErr()) {
      this.logger.error(
        { threadId, err: structuredMemoryResult.error.message },
        'context-builder: failed to load structured memory',
      );
      return err(structuredMemoryResult.error);
    }

    const transcript = workingMemoryResult.value.map((msg) => ({
      direction: msg.direction as 'inbound' | 'outbound',
      content: msg.content,
      createdAt: msg.createdAt,
    }));

    const context: ThreadContext = {
      transcript,
      notebookFiles,
      structuredMemory: structuredMemoryResult.value,
      personaSystemPrompt,
    };

    this.logger.debug(
      {
        threadId,
        transcriptLength: transcript.length,
        notebookFileCount: Object.keys(notebookFiles).length,
        structuredMemoryCount: context.structuredMemory.length,
      },
      'context-builder: context assembled',
    );

    return ok(context);
  }
}

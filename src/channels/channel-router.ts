/**
 * Channel router — resolves the persona for an inbound channel+thread pair.
 *
 * Resolution order (per spec section 7.1):
 *  1. Specific binding: (channelId, threadId) -> personaId
 *  2. Default binding:  (channelId, is_default=1) -> personaId
 *  3. null             — no binding found; caller should drop with audit log
 */

import type pino from 'pino';
import type { Result } from '../core/types/result.js';
import { ok, err } from '../core/types/result.js';
import { ChannelError } from '../core/errors/error-types.js';
import type { BindingRepository } from '../core/database/repositories/binding-repository.js';

/**
 * Routes inbound channel events to the appropriate persona by consulting the
 * `bindings` table.
 *
 * This class is intentionally thin — it performs two DB look-ups and returns
 * a Result. Audit logging for the "no binding" case should happen at the
 * call site (message ingestion layer) where the full event context is available.
 */
export class ChannelRouter {
  constructor(
    private readonly bindingRepo: BindingRepository,
    private readonly logger: pino.Logger,
  ) {}

  /**
   * Resolve the persona bound to the given channel + thread combination.
   *
   * @param channelId - The canonical channel row ID (UUID).
   * @param threadId  - The canonical thread row ID (UUID), or `null` to query
   *                    only channel-level defaults.
   * @returns
   *   - `Ok(personaId)` — a persona was found.
   *   - `Ok(null)`      — no binding exists; message should be dropped.
   *   - `Err(ChannelError)` — a database error occurred.
   */
  resolvePersona(
    channelId: string,
    threadId: string | null,
  ): Result<string | null, ChannelError> {
    // Step 1: specific (channel, thread) binding — only when threadId is provided.
    if (threadId !== null) {
      const specificResult = this.bindingRepo.findByChannelAndThread(channelId, threadId);
      if (specificResult.isErr()) {
        return err(
          new ChannelError(
            `Failed to look up specific binding for channel ${channelId}, thread ${threadId}: ${specificResult.error.message}`,
            specificResult.error,
          ),
        );
      }
      const specific = specificResult.value;
      if (specific !== null) {
        this.logger.debug(
          { channelId, threadId, personaId: specific.persona_id },
          'resolved persona via specific binding',
        );
        return ok(specific.persona_id);
      }
    }

    // Step 2: channel default binding.
    const defaultResult = this.bindingRepo.findDefaultForChannel(channelId);
    if (defaultResult.isErr()) {
      return err(
        new ChannelError(
          `Failed to look up default binding for channel ${channelId}: ${defaultResult.error.message}`,
          defaultResult.error,
        ),
      );
    }
    const defaultBinding = defaultResult.value;
    if (defaultBinding !== null) {
      this.logger.debug(
        { channelId, threadId, personaId: defaultBinding.persona_id },
        'resolved persona via channel default binding',
      );
      return ok(defaultBinding.persona_id);
    }

    // Step 3: no binding found.
    this.logger.warn(
      { channelId, threadId },
      'no persona binding found for channel+thread; message will be dropped',
    );
    return ok(null);
  }
}

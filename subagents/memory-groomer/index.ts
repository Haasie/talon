import { generateText } from 'ai';
import { ok, err } from 'neverthrow';
import type { Result } from 'neverthrow';
import type { SubAgentContext, SubAgentInput, SubAgentResult } from '../../src/subagents/subagent-types.js';
import { SubAgentError } from '../../src/core/errors/index.js';
import type { MemoryItemRow, InsertMemoryItemInput } from '../../src/core/database/repositories/memory-repository.js';

/** Shape of a single grooming action returned by the model. */
interface GroomAction {
  type: 'prune' | 'consolidate' | 'keep';
  ids: string[];
  reason: string;
  mergedContent?: string;
}

/** Top-level response shape from the model. */
interface GroomResponse {
  actions: GroomAction[];
}

/** Format memory items into a numbered list for the model prompt. */
function formatMemories(items: MemoryItemRow[]): string {
  return items
    .map(
      (item, idx) =>
        `${idx + 1}. [id=${item.id}] type=${item.type} created=${new Date(item.created_at).toISOString()}\n   ${item.content}`,
    )
    .join('\n\n');
}

/** Validate that a single action object has the required shape. */
function isValidAction(action: unknown): action is GroomAction {
  if (typeof action !== 'object' || action === null) return false;
  const a = action as Record<string, unknown>;
  if (a.type !== 'prune' && a.type !== 'consolidate' && a.type !== 'keep') return false;
  if (!Array.isArray(a.ids) || a.ids.length === 0) return false;
  if (!a.ids.every((id: unknown) => typeof id === 'string' && id.length > 0)) return false;
  if (typeof a.reason !== 'string') return false;
  if (a.type === 'consolidate' && typeof a.mergedContent !== 'string') return false;
  return true;
}

/** Attempt to parse the model response as a GroomResponse. */
function parseResponse(text: string): GroomResponse | null {
  try {
    // Strip markdown code fences if present.
    const cleaned = text.replace(/```(?:json)?\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed: unknown = JSON.parse(cleaned);
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed) ||
      !Array.isArray((parsed as GroomResponse).actions)
    ) {
      return null;
    }
    // Filter to only well-formed actions.
    const validActions = (parsed as GroomResponse).actions.filter(isValidAction);
    return { actions: validActions };
  } catch {
    return null;
  }
}

/** Generate a unique id for a consolidated memory entry. */
function makeId(): string {
  return `mem_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export async function run(
  ctx: SubAgentContext,
  _input: SubAgentInput,
): Promise<Result<SubAgentResult, SubAgentError>> {
  const { memory, logger } = ctx.services;

  // 1. Read all memory items for this thread.
  const findResult = memory.findByThread(ctx.threadId);
  if (findResult.isErr()) {
    return err(new SubAgentError(`Failed to read memory items: ${findResult.error.message}`));
  }

  const items = findResult.value;
  if (items.length === 0) {
    return ok({
      summary: 'No memory items to groom.',
      data: { pruned: 0, consolidated: 0, kept: 0 },
    });
  }

  // 2. Format memories and send to model.
  const prompt = `Review the following ${items.length} memory entries and recommend grooming actions:\n\n${formatMemories(items)}`;

  try {
    const { text, usage } = await generateText({
      model: ctx.model,
      system: ctx.systemPrompt,
      prompt,
      maxOutputTokens: 4096,
    });

    // 3. Parse model response.
    const response = parseResponse(text);
    if (!response || response.actions.length === 0) {
      return ok({
        summary: 'Memory grooming complete. No changes recommended.',
        data: { pruned: 0, consolidated: 0, kept: 0 },
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens: usage?.outputTokens ?? 0,
          costUsd: 0,
        },
      });
    }

    // 4. Execute actions — only operate on IDs that exist in the fetched items.
    const knownIds = new Set(items.map((i) => i.id));
    let pruned = 0;
    let consolidated = 0;
    let kept = 0;

    for (const action of response.actions) {
      // Filter out any IDs the model hallucinated.
      const validIds = action.ids.filter((id) => knownIds.has(id));
      if (validIds.length === 0) {
        logger.warn({ action }, 'All IDs in action are unknown, skipping');
        continue;
      }
      action.ids = validIds;
      switch (action.type) {
        case 'prune': {
          for (const id of action.ids) {
            const deleteResult = memory.delete(ctx.threadId, id);
            if (deleteResult.isErr()) {
              logger.warn({ id, error: deleteResult.error.message }, 'Failed to delete memory item during prune');
            } else {
              pruned++;
            }
          }
          break;
        }

        case 'consolidate': {
          if (action.ids.length < 2) {
            logger.warn({ action }, 'Skipping consolidate action with fewer than 2 ids');
            break;
          }

          // Find the first source item to inherit its type and metadata.
          const sourceItem = items.find((i) => i.id === action.ids[0]);
          if (!sourceItem) {
            logger.warn({ ids: action.ids }, 'Source item not found for consolidation');
            break;
          }

          // Insert merged entry FIRST to prevent data loss if insert fails.
          const newItem: InsertMemoryItemInput = {
            id: makeId(),
            thread_id: ctx.threadId,
            type: sourceItem.type,
            content: action.mergedContent!,
            embedding_ref: null,
            metadata: sourceItem.metadata,
          };
          const insertResult = memory.insert(newItem);
          if (insertResult.isErr()) {
            logger.warn({ error: insertResult.error.message }, 'Failed to insert consolidated memory item, skipping consolidation');
            break;
          }

          // Delete source entries only after successful insert.
          for (const id of action.ids) {
            const deleteResult = memory.delete(ctx.threadId, id);
            if (deleteResult.isErr()) {
              logger.warn({ id, error: deleteResult.error.message }, 'Failed to delete memory item during consolidation');
            }
          }
          consolidated++;
          break;
        }

        case 'keep': {
          kept += action.ids.length;
          break;
        }
      }
    }

    return ok({
      summary: `Memory grooming complete: ${pruned} pruned, ${consolidated} consolidated, ${kept} kept.`,
      data: { pruned, consolidated, kept },
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? 0,
        costUsd: 0,
      },
    });
  } catch (error) {
    return err(
      new SubAgentError(
        `Memory grooming failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
}

/**
 * Host-side tool: schedule.manage
 *
 * Creates, updates, or cancels scheduled tasks on behalf of a persona.
 * Gated by the `schedule.write:own` capability.
 */

import type pino from 'pino';
import { v4 as uuidv4 } from 'uuid';
import type { ToolManifest, ToolCallResult } from '../tool-types.js';
import type { ScheduleRepository } from '../../core/database/repositories/schedule-repository.js';
import { ToolError } from '../../core/errors/error-types.js';
import type { ToolExecutionContext } from './channel-send.js';

/** Manifest for the schedule.manage host tool. */
export interface ScheduleManageTool {
  readonly manifest: ToolManifest;
}

/** Arguments accepted by the schedule.manage tool. */
export interface ScheduleManageArgs {
  /** Action to perform on the schedule entry. */
  action: 'create' | 'update' | 'cancel';
  /** Unique schedule identifier (required for update/cancel). */
  scheduleId?: string;
  /** Cron expression defining when the task fires (required for create/update). */
  cronExpr?: string;
  /** Human-readable label for the scheduled task. */
  label?: string;
  /** Prompt or instruction to execute when the schedule fires. */
  prompt?: string;
}

/** Valid actions for the schedule.manage tool. */
const VALID_ACTIONS = new Set(['create', 'update', 'cancel']);

/**
 * Basic validation for cron expressions.
 *
 * Accepts standard 5-field cron format: minute hour day-of-month month day-of-week.
 * Each field may be a number, '*', or a simple expression. This is intentionally
 * lenient — the scheduler will perform stricter validation at runtime.
 */
const CRON_PATTERN = /^(\S+\s+){4}\S+$/;

/**
 * Handler class for the schedule.manage host tool.
 *
 * Creates, updates, or cancels scheduled tasks via the ScheduleRepository.
 * Schedules are owned by the persona and scoped to the current thread.
 */
export class ScheduleManageHandler {
  /** Static manifest describing the tool. */
  static readonly manifest: ToolManifest = {
    name: 'schedule.manage',
    description:
      'Creates, updates, or cancels scheduled tasks on behalf of a persona. Gated by schedule.write:own.',
    capabilities: ['schedule.write:own'],
    executionLocation: 'host',
  };

  constructor(
    private readonly deps: {
      scheduleRepository: ScheduleRepository;
      logger: pino.Logger;
    },
  ) {}

  /**
   * Execute the schedule.manage tool.
   *
   * @param args    - Validated tool arguments.
   * @param context - Execution context (runId, threadId, personaId).
   * @returns ToolCallResult with status 'success' or 'error'.
   */
  execute(args: ScheduleManageArgs, context: ToolExecutionContext): Promise<ToolCallResult> {
    return Promise.resolve(this.executeSync(args, context));
  }

  /** Synchronous dispatch — wrapped by execute() to satisfy the async tool interface. */
  private executeSync(args: ScheduleManageArgs, context: ToolExecutionContext): ToolCallResult {
    const requestId = context.requestId ?? 'unknown';
    const { action } = args;

    this.deps.logger.info(
      { requestId, runId: context.runId, personaId: context.personaId, action },
      'schedule.manage: executing',
    );

    // Validate action
    if (!action || !VALID_ACTIONS.has(action)) {
      const error = new ToolError(
        `schedule.manage: invalid action "${action}". Must be one of: create, update, cancel`,
      );
      this.deps.logger.warn({ requestId, action }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    switch (action) {
      case 'create':
        return this.handleCreate(args, context, requestId);
      case 'update':
        return this.handleUpdate(args, context, requestId);
      case 'cancel':
        return this.handleCancel(args, context, requestId);
      default: {
        // TypeScript exhaustiveness guard
        const error = new ToolError(`schedule.manage: unknown action "${action as string}"`);
        return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
      }
    }
  }

  /** Handle the 'create' action — insert a new schedule. */
  private handleCreate(
    args: ScheduleManageArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { cronExpr, label, prompt } = args;

    if (!cronExpr || typeof cronExpr !== 'string' || cronExpr.trim() === '') {
      const error = new ToolError('schedule.manage: cronExpr is required for create action');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    if (!CRON_PATTERN.test(cronExpr.trim())) {
      const error = new ToolError(
        `schedule.manage: invalid cron expression "${cronExpr}". Expected 5-field cron format (minute hour day month weekday)`,
      );
      this.deps.logger.warn({ requestId, cronExpr }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    const scheduleId = uuidv4();
    const payload = JSON.stringify({
      label: label ?? '',
      prompt: prompt ?? '',
    });

    const insertResult = this.deps.scheduleRepository.insert({
      id: scheduleId,
      persona_id: context.personaId,
      thread_id: context.threadId,
      type: 'cron',
      expression: cronExpr.trim(),
      payload,
      enabled: 1,
      last_run_at: null,
      next_run_at: null,
    });

    if (insertResult.isErr()) {
      const msg = `schedule.manage: create failed — ${insertResult.error.message}`;
      this.deps.logger.error({ requestId, err: insertResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    this.deps.logger.info(
      { requestId, scheduleId, personaId: context.personaId },
      'schedule.manage: schedule created',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { scheduleId, action: 'create', created: true },
    };
  }

  /** Handle the 'update' action — update an existing schedule's fields. */
  private handleUpdate(
    args: ScheduleManageArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { scheduleId, cronExpr, label, prompt } = args;

    if (!scheduleId || typeof scheduleId !== 'string' || scheduleId.trim() === '') {
      const error = new ToolError('schedule.manage: scheduleId is required for update action');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    if (cronExpr !== undefined && !CRON_PATTERN.test(cronExpr.trim())) {
      const error = new ToolError(
        `schedule.manage: invalid cron expression "${cronExpr}". Expected 5-field cron format`,
      );
      this.deps.logger.warn({ requestId, cronExpr }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    // Build a dynamic UPDATE. We only update expression and payload if provided.
    const fields: Record<string, unknown> = {};
    if (cronExpr !== undefined) {
      fields['expression'] = cronExpr.trim();
    }
    if (label !== undefined || prompt !== undefined) {
      fields['payload'] = JSON.stringify({
        label: label ?? '',
        prompt: prompt ?? '',
      });
    }

    if (Object.keys(fields).length === 0) {
      const error = new ToolError(
        'schedule.manage: no fields provided to update (provide at least one of: cronExpr, label, prompt)',
      );
      this.deps.logger.warn({ requestId, scheduleId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    // Build a typed UpdateScheduleInput from the collected fields
    const updateInput: { expression?: string; payload?: string } = {};
    if (typeof fields['expression'] === 'string') {
      updateInput.expression = fields['expression'];
    }
    if (typeof fields['payload'] === 'string') {
      updateInput.payload = fields['payload'];
    }

    const updateResult = this.deps.scheduleRepository.update(scheduleId, context.personaId, updateInput);
    if (updateResult.isErr()) {
      const msg = `schedule.manage: update failed — ${updateResult.error.message}`;
      this.deps.logger.error({ requestId, scheduleId, err: updateResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    this.deps.logger.info(
      { requestId, scheduleId, personaId: context.personaId },
      'schedule.manage: schedule updated',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { scheduleId, action: 'update', updated: true },
    };
  }

  /** Handle the 'cancel' action — disable the schedule (sets enabled=0). */
  private handleCancel(
    args: ScheduleManageArgs,
    context: ToolExecutionContext,
    requestId: string,
  ): ToolCallResult {
    const { scheduleId } = args;

    if (!scheduleId || typeof scheduleId !== 'string' || scheduleId.trim() === '') {
      const error = new ToolError('schedule.manage: scheduleId is required for cancel action');
      this.deps.logger.warn({ requestId }, error.message);
      return { requestId, tool: 'schedule.manage', status: 'error', error: error.message };
    }

    const disableResult = this.deps.scheduleRepository.disable(scheduleId);
    if (disableResult.isErr()) {
      const msg = `schedule.manage: cancel failed — ${disableResult.error.message}`;
      this.deps.logger.error({ requestId, scheduleId, err: disableResult.error }, msg);
      return { requestId, tool: 'schedule.manage', status: 'error', error: msg };
    }

    this.deps.logger.info(
      { requestId, scheduleId, personaId: context.personaId },
      'schedule.manage: schedule cancelled',
    );

    return {
      requestId,
      tool: 'schedule.manage',
      status: 'success',
      result: { scheduleId, action: 'cancel', cancelled: true },
    };
  }
}

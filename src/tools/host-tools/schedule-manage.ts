/**
 * Host-side tool: schedule.manage
 *
 * Creates, updates, or cancels scheduled tasks on behalf of a persona.
 * Gated by the `schedule.write:own` capability.
 *
 * @remarks Full implementation in TASK-029.
 */

import type { ToolManifest } from '../tool-types.js';

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

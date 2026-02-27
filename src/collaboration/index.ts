/**
 * Agent collaboration / swarms.
 *
 * Orchestrates multi-agent workflows where a lead persona spawns sub-agents
 * to handle parallel subtasks. Manages result aggregation and error handling
 * across the swarm. Built on the Claude agent SDK subagent primitives.
 */

export type {
  RetryPolicy,
  SupervisorConfig,
  WorkerConfig,
  ChildRunInfo,
  CollaborationSession,
  WorkerResult,
} from './collaboration-types.js';

export { Supervisor } from './supervisor.js';
export { WorkerManager } from './worker-manager.js';

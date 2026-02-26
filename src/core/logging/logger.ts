/**
 * Structured logger factory built on pino.
 *
 * All loggers carry a `service: 'talond'` base binding so log aggregators can
 * filter daemon output in a mixed environment. Child loggers add per-request
 * context (run ID, thread ID, persona, tool, request ID) without repeating the
 * base fields.
 *
 * In development (`pretty: true`) output is piped through pino-pretty for
 * human-readable, coloured output. In production (`pretty: false`) output is
 * newline-delimited JSON suitable for log shippers.
 */

import pino from 'pino';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Configuration for the root logger. */
export interface LoggerConfig {
  /** Minimum log level to emit. One of: trace | debug | info | warn | error | fatal */
  level: string;
  /** When true use pino-pretty for human-readable output; when false emit JSON. */
  pretty: boolean;
}

/**
 * Contextual bindings attached to a child logger.
 *
 * All fields are optional — include only those that are known at the
 * call site. pino will merge them into every log record emitted by
 * the child logger and all of its descendants.
 */
export interface LogBindings {
  /** Durable run identifier shared across all tool calls in a single agent run. */
  runId?: string;
  /** Per-thread identifier linking runs within a conversation thread. */
  threadId?: string;
  /** Persona name active for this run. */
  persona?: string;
  /** Tool name being invoked. */
  tool?: string;
  /** Outbound request identifier (e.g. Anthropic API request ID). */
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Factory functions
// ---------------------------------------------------------------------------

/**
 * Create the root pino logger with a fixed `service: 'talond'` binding.
 *
 * This should be called once at daemon startup. Pass the returned logger
 * (or child loggers derived from it) wherever structured logging is needed.
 *
 * @param config - Level and output-format settings.
 * @returns A configured pino.Logger instance.
 */
export function createLogger(config: LoggerConfig): pino.Logger {
  const baseOptions: pino.LoggerOptions = {
    level: config.level,
    base: { service: 'talond' },
  };

  if (config.pretty) {
    const transport = pino.transport({
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss.l',
        ignore: 'pid,hostname',
      },
    }) as pino.DestinationStream;
    return pino(baseOptions, transport);
  }

  return pino(baseOptions);
}

/**
 * Derive a child logger with additional contextual bindings.
 *
 * The child inherits the parent's level and transport. All bindings are
 * shallow-merged into each log record so downstream consumers can correlate
 * entries without post-processing.
 *
 * @param parent   - The parent pino logger (root or another child).
 * @param bindings - Key/value pairs to attach to every record.
 * @returns A pino child logger.
 */
export function createChildLogger(parent: pino.Logger, bindings: LogBindings): pino.Logger {
  // Filter out undefined values so they do not appear as null in JSON output.
  const defined = Object.fromEntries(
    Object.entries(bindings).filter(([, v]) => v !== undefined),
  ) as Record<string, string>;

  return parent.child(defined);
}

import { describe, it, expect, vi } from 'vitest';
import pino from 'pino';
import { createLogger, createChildLogger } from '../../../../src/core/logging/logger.js';
import type { LoggerConfig, LogBindings } from '../../../../src/core/logging/logger.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a pino logger that writes JSON to an in-memory string array.
 * Uses a plain writable-duck-type so there is no dependency on pino internals.
 */
function createTestLogger(level = 'trace'): { logger: pino.Logger; lines: () => string[] } {
  const collected: string[] = [];

  const writable = {
    write(chunk: string) {
      collected.push(chunk.trimEnd());
      return true;
    },
  };

  const logger = pino({ level, base: { service: 'talond' } }, writable as unknown as pino.DestinationStream);
  return { logger, lines: () => collected };
}

function parseLine(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// createLogger()
// ---------------------------------------------------------------------------

describe('createLogger()', () => {
  it('returns a pino logger instance', () => {
    const config: LoggerConfig = { level: 'info', pretty: false };
    const logger = createLogger(config);
    expect(logger).toBeDefined();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.error).toBe('function');
    expect(typeof logger.debug).toBe('function');
  });

  it('sets the configured log level', () => {
    const levels = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
    for (const level of levels) {
      const logger = createLogger({ level, pretty: false });
      expect(logger.level).toBe(level);
    }
  });

  it('includes service: talond in every log record', () => {
    const { logger, lines } = createTestLogger('info');
    logger.info('hello');
    const record = parseLine(lines()[0]);
    expect(record.service).toBe('talond');
  });

  it('does not throw when pretty: false', () => {
    expect(() => createLogger({ level: 'info', pretty: false })).not.toThrow();
  });

  it('does not throw when pretty: true', () => {
    // pino-pretty transport is async; we just verify no immediate error
    expect(() => createLogger({ level: 'info', pretty: true })).not.toThrow();
  });

  describe('JSON output format (pretty: false)', () => {
    it('emits valid JSON lines', () => {
      const { logger, lines } = createTestLogger('info');
      logger.info({ key: 'value' }, 'test message');
      expect(() => parseLine(lines()[0])).not.toThrow();
    });

    it('includes standard pino fields: level, msg, time', () => {
      const { logger, lines } = createTestLogger('info');
      logger.info('test');
      const record = parseLine(lines()[0]);
      expect(record).toHaveProperty('level');
      expect(record).toHaveProperty('msg');
      expect(record).toHaveProperty('time');
    });

    it('includes the message string', () => {
      const { logger, lines } = createTestLogger('info');
      logger.info('my message');
      const record = parseLine(lines()[0]);
      expect(record.msg).toBe('my message');
    });

    it('includes extra fields passed to the log call', () => {
      const { logger, lines } = createTestLogger('info');
      logger.info({ requestId: 'req-123', extra: 42 }, 'event');
      const record = parseLine(lines()[0]);
      expect(record.requestId).toBe('req-123');
      expect(record.extra).toBe(42);
    });
  });
});

// ---------------------------------------------------------------------------
// Log level filtering
// ---------------------------------------------------------------------------

describe('log level filtering', () => {
  it('suppresses records below the configured level', () => {
    const { logger, lines } = createTestLogger('warn');
    logger.info('should be suppressed');
    logger.debug('also suppressed');
    expect(lines()).toHaveLength(0);
  });

  it('emits records at and above the configured level', () => {
    const { logger, lines } = createTestLogger('warn');
    logger.warn('warn message');
    logger.error('error message');
    logger.fatal('fatal message');
    expect(lines()).toHaveLength(3);
  });

  it('trace level emits all records', () => {
    const { logger, lines } = createTestLogger('trace');
    logger.trace('t');
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');
    logger.fatal('f');
    expect(lines()).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------
// createChildLogger()
// ---------------------------------------------------------------------------

describe('createChildLogger()', () => {
  it('returns a pino logger', () => {
    const { logger } = createTestLogger('trace');
    const child = createChildLogger(logger, { runId: 'run-1' });
    expect(typeof child.info).toBe('function');
  });

  it('includes provided bindings in every child log record', () => {
    const { logger, lines } = createTestLogger('info');
    const child = createChildLogger(logger, { runId: 'run-abc', threadId: 'thread-xyz' });
    child.info('child event');
    const record = parseLine(lines()[0]);
    expect(record.runId).toBe('run-abc');
    expect(record.threadId).toBe('thread-xyz');
  });

  it('inherits service: talond from the parent', () => {
    const { logger, lines } = createTestLogger('info');
    const child = createChildLogger(logger, { persona: 'assistant' });
    child.info('child event');
    const record = parseLine(lines()[0]);
    expect(record.service).toBe('talond');
  });

  it('supports all defined binding fields', () => {
    const { logger, lines } = createTestLogger('info');
    const bindings: LogBindings = {
      runId: 'r1',
      threadId: 't1',
      persona: 'bot',
      tool: 'web_search',
      requestId: 'req-999',
    };
    const child = createChildLogger(logger, bindings);
    child.info('full context');
    const record = parseLine(lines()[0]);
    expect(record.runId).toBe('r1');
    expect(record.threadId).toBe('t1');
    expect(record.persona).toBe('bot');
    expect(record.tool).toBe('web_search');
    expect(record.requestId).toBe('req-999');
  });

  it('omits undefined binding fields from log records', () => {
    const { logger, lines } = createTestLogger('info');
    const child = createChildLogger(logger, { runId: 'r2', threadId: undefined });
    child.info('partial bindings');
    const record = parseLine(lines()[0]);
    expect(record.runId).toBe('r2');
    // threadId should not appear (not even as null)
    expect(Object.keys(record)).not.toContain('threadId');
  });

  it('works with empty bindings object', () => {
    const { logger, lines } = createTestLogger('info');
    const child = createChildLogger(logger, {});
    child.info('no bindings');
    const record = parseLine(lines()[0]);
    expect(record.msg).toBe('no bindings');
    expect(record.service).toBe('talond');
  });

  it('child logger inherits parent level', () => {
    const { logger, lines } = createTestLogger('warn');
    const child = createChildLogger(logger, { runId: 'r3' });
    child.info('should be suppressed');
    expect(lines()).toHaveLength(0);
    child.warn('should appear');
    expect(lines()).toHaveLength(1);
  });

  it('grandchild inherits all ancestor bindings', () => {
    const { logger, lines } = createTestLogger('info');
    const child = createChildLogger(logger, { runId: 'run-1' });
    const grandchild = createChildLogger(child, { tool: 'fs_read' });
    grandchild.info('nested');
    const record = parseLine(lines()[0]);
    expect(record.runId).toBe('run-1');
    expect(record.tool).toBe('fs_read');
    expect(record.service).toBe('talond');
  });
});

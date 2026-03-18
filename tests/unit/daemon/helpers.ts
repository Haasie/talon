import { Writable } from 'node:stream';
import pino from 'pino';

/**
 * Creates a logger whose output is discarded even if the level changes later.
 * Useful for daemon tests that intentionally mutate logger.level during startup.
 */
export function createDiscardLogger(level = 'silent'): pino.Logger {
  const destination = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });

  return pino({ level }, destination as unknown as pino.DestinationStream);
}

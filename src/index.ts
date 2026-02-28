/**
 * talond — Talon daemon entry point.
 *
 * Starts the daemon process, loads configuration, initialises subsystems,
 * and enters the main event loop.
 */

import { createLogger } from './core/logging/logger.js';
import { TalondDaemon } from './daemon/daemon.js';
import { setupSignalHandlers } from './daemon/signal-handler.js';

function parseConfigPath(argv: string[]): string {
  const configFlagIndex = argv.findIndex((arg) => arg === '--config' || arg === '-c');
  if (configFlagIndex !== -1) {
    const value = argv[configFlagIndex + 1];
    if (value && !value.startsWith('-')) {
      return value;
    }
  }
  return process.env.TALOND_CONFIG_PATH ?? 'talond.yaml';
}

async function main(): Promise<void> {
  const logger = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    pretty: process.stdout.isTTY,
  });

  const configPath = parseConfigPath(process.argv.slice(2));
  const daemon = new TalondDaemon(logger);

  const startResult = await daemon.start(configPath);
  if (startResult.isErr()) {
    logger.fatal({ err: startResult.error.message, configPath }, 'talond failed to start');
    process.exit(1);
  }

  setupSignalHandlers(daemon, logger);
  logger.info({ configPath }, 'talond started');
}

main().catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  process.stderr.write(`talond failed to bootstrap: ${message}\n`);
  process.exit(1);
});

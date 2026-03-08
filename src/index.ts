/**
 * talond — Talon daemon entry point.
 *
 * Starts the daemon process, loads configuration, initialises subsystems,
 * and enters the main event loop.
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
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

function parseEnvFilePath(argv: string[]): string {
  const flagIndex = argv.findIndex((arg) => arg === '--env-file');
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (value && !value.startsWith('-')) {
      return value;
    }
  }
  return process.env.TALOND_ENV_FILE ?? '.env';
}

function loadEnvFile(path: string): { loaded: boolean; path: string; error?: string } {
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    return { loaded: false, path: resolved };
  }
  try {
    process.loadEnvFile(resolved);
    return { loaded: true, path: resolved };
  } catch (cause) {
    return { loaded: false, path: resolved, error: cause instanceof Error ? cause.message : String(cause) };
  }
}

async function main(): Promise<void> {
  const envFile = loadEnvFile(parseEnvFilePath(process.argv.slice(2)));

  const logger = createLogger({
    level: process.env.LOG_LEVEL ?? 'info',
    pretty: process.stdout.isTTY,
  });

  if (envFile.loaded) {
    logger.info({ envFile: envFile.path }, 'loaded .env file');
  } else if (envFile.error) {
    logger.warn({ envFile: envFile.path, error: envFile.error }, 'failed to load .env file');
  }

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

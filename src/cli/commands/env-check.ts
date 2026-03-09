/**
 * `talonctl env-check` command.
 *
 * Scans the config file for ${ENV_VAR} placeholders and reports
 * which ones are set and which are missing from the environment.
 */

import fs from 'node:fs/promises';

import { DEFAULT_CONFIG_PATH } from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EnvCheckOptions {
  configPath?: string;
}

export interface EnvVar {
  name: string;
  isSet: boolean;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/** Pattern to match ${VAR_NAME} placeholders in config. */
const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/**
 * Scans the config file for ${ENV_VAR} placeholders and checks
 * which are set in the current environment.
 *
 * @returns List of env vars found with their set/unset status.
 * @throws Error if the config file can't be read.
 */
export async function envCheck(options: EnvCheckOptions = {}): Promise<EnvVar[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  let rawContent: string;
  try {
    rawContent = await fs.readFile(configPath, 'utf-8');
  } catch {
    throw new Error(`Config file "${configPath}" not found.`);
  }

  // Find all unique ${VAR} references.
  const varNames = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = ENV_VAR_PATTERN.exec(rawContent)) !== null) {
    varNames.add(match[1]!);
  }

  return Array.from(varNames)
    .sort()
    .map((name) => ({
      name,
      isSet: process.env[name] !== undefined,
    }));
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function envCheckCommand(options: EnvCheckOptions = {}): Promise<void> {
  try {
    const vars = await envCheck(options);

    if (vars.length === 0) {
      console.log('No ${ENV_VAR} placeholders found in config.');
      return;
    }

    console.log(`${'VARIABLE'.padEnd(35)} STATUS`);
    console.log(`${'─'.repeat(35)} ${'─'.repeat(10)}`);

    let missingCount = 0;
    for (const v of vars) {
      const status = v.isSet ? 'SET' : 'MISSING';
      if (!v.isSet) missingCount++;
      console.log(`${v.name.padEnd(35)} ${status}`);
    }

    console.log('');
    if (missingCount > 0) {
      console.log(`${missingCount} variable(s) missing. Set them in .env or environment before starting talond.`);
    } else {
      console.log('All environment variables are set.');
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

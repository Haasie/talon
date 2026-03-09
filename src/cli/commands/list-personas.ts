/**
 * `talonctl list-personas` command.
 *
 * Prints all personas from talond.yaml in table format.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListPersonasOptions {
  configPath?: string;
}

export interface PersonaInfo {
  name: string;
  model: string;
  skillCount: number;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Returns all personas from the config file.
 *
 * @throws Error if the config file can't be read.
 */
export async function listPersonas(options: ListPersonasOptions = {}): Promise<PersonaInfo[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const doc = await readConfig(configPath);

  if (!Array.isArray(doc.personas)) {
    return [];
  }

  return doc.personas.map((p) => ({
    name: p.name,
    model: p.model ?? '(default)',
    skillCount: Array.isArray(p.skills) ? p.skills.length : 0,
  }));
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function listPersonasCommand(options: ListPersonasOptions = {}): Promise<void> {
  try {
    const personas = await listPersonas(options);

    if (personas.length === 0) {
      console.log('No personas configured.');
      return;
    }

    console.log(`${'NAME'.padEnd(25)} ${'MODEL'.padEnd(25)} SKILLS`);
    console.log(`${'─'.repeat(25)} ${'─'.repeat(25)} ${'─'.repeat(6)}`);

    for (const p of personas) {
      console.log(`${p.name.padEnd(25)} ${p.model.padEnd(25)} ${p.skillCount}`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

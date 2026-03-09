/**
 * `talonctl remove-persona` command.
 *
 * Removes a persona from talond.yaml by name.
 * Warns about existing bindings and skills directory.
 */

import { existsSync } from 'node:fs';

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemovePersonaOptions {
  name: string;
  configPath?: string;
  personasDir?: string;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Removes a persona from the config file.
 *
 * Does NOT delete the persona directory — only removes the config entry.
 *
 * @throws Error if the persona doesn't exist.
 */
export async function removePersona(options: RemovePersonaOptions): Promise<{ warnings: string[] }> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const personasDir = options.personasDir ?? 'personas';

  if (!options.name || options.name.trim().length === 0) {
    throw new Error('Persona name is required.');
  }

  const doc = await readConfig(configPath);

  if (!Array.isArray(doc.personas)) {
    throw new Error(`Persona "${options.name}" not found in "${configPath}".`);
  }

  const idx = doc.personas.findIndex((p) => p.name === options.name);
  if (idx === -1) {
    throw new Error(`Persona "${options.name}" not found in "${configPath}".`);
  }

  const warnings: string[] = [];

  // Check for bindings referencing this persona.
  if (Array.isArray(doc.bindings)) {
    const boundBindings = doc.bindings.filter((b) => b.persona === options.name);
    if (boundBindings.length > 0) {
      warnings.push(
        `Removed ${boundBindings.length} binding(s) referencing persona "${options.name}".`,
      );
      doc.bindings = doc.bindings.filter((b) => b.persona !== options.name);
    }
  }

  // Warn about persona directory.
  const personaDir = `${personasDir}/${options.name}`;
  if (existsSync(personaDir)) {
    warnings.push(
      `Persona directory "${personaDir}" still exists. Delete it manually if no longer needed.`,
    );
  }

  doc.personas.splice(idx, 1);

  await writeConfigAtomic(configPath, doc);

  return { warnings };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function removePersonaCommand(options: RemovePersonaOptions): Promise<void> {
  try {
    const { warnings } = await removePersona(options);
    for (const w of warnings) {
      console.warn(`Warning: ${w}`);
    }
    console.log(`Removed persona "${options.name}" from "${options.configPath ?? DEFAULT_CONFIG_PATH}".`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

/**
 * `talonctl remove-channel` command.
 *
 * Removes a channel from talond.yaml by name.
 * Warns about existing bindings.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemoveChannelOptions {
  name: string;
  configPath?: string;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Removes a channel from the config file.
 *
 * @throws Error if the channel doesn't exist.
 */
export async function removeChannel(options: RemoveChannelOptions): Promise<{ warnings: string[] }> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  if (!options.name || options.name.trim().length === 0) {
    throw new Error('Channel name is required.');
  }

  const doc = await readConfig(configPath);

  if (!Array.isArray(doc.channels)) {
    throw new Error(`Channel "${options.name}" not found in "${configPath}".`);
  }

  const idx = doc.channels.findIndex((c) => c.name === options.name);
  if (idx === -1) {
    throw new Error(`Channel "${options.name}" not found in "${configPath}".`);
  }

  const warnings: string[] = [];

  // Check for bindings referencing this channel.
  if (Array.isArray(doc.bindings)) {
    const boundBindings = doc.bindings.filter((b) => b.channel === options.name);
    if (boundBindings.length > 0) {
      warnings.push(
        `Removed ${boundBindings.length} binding(s) referencing channel "${options.name}".`,
      );
      doc.bindings = doc.bindings.filter((b) => b.channel !== options.name);
    }
  }

  doc.channels.splice(idx, 1);

  await writeConfigAtomic(configPath, doc);

  return { warnings };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function removeChannelCommand(options: RemoveChannelOptions): Promise<void> {
  try {
    const { warnings } = await removeChannel(options);
    for (const w of warnings) {
      console.warn(`Warning: ${w}`);
    }
    console.log(`Removed channel "${options.name}" from "${options.configPath ?? DEFAULT_CONFIG_PATH}".`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

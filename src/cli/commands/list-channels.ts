/**
 * `talonctl list-channels` command.
 *
 * Prints all channels from talond.yaml in table format.
 */

import {
  DEFAULT_CONFIG_PATH,
  readConfig,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ListChannelsOptions {
  configPath?: string;
}

export interface ChannelInfo {
  name: string;
  type: string;
  enabled: boolean;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Returns all channels from the config file.
 *
 * @throws Error if the config file can't be read.
 */
export async function listChannels(options: ListChannelsOptions = {}): Promise<ChannelInfo[]> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const doc = await readConfig(configPath);

  if (!Array.isArray(doc.channels)) {
    return [];
  }

  return doc.channels.map((ch) => ({
    name: ch.name,
    type: ch.type,
    enabled: ch.enabled !== false,
  }));
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function listChannelsCommand(options: ListChannelsOptions = {}): Promise<void> {
  try {
    const channels = await listChannels(options);

    if (channels.length === 0) {
      console.log('No channels configured.');
      return;
    }

    // Table header.
    console.log(`${'NAME'.padEnd(25)} ${'TYPE'.padEnd(12)} ENABLED`);
    console.log(`${'─'.repeat(25)} ${'─'.repeat(12)} ${'─'.repeat(7)}`);

    for (const ch of channels) {
      console.log(`${ch.name.padEnd(25)} ${ch.type.padEnd(12)} ${ch.enabled ? 'yes' : 'no'}`);
    }
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

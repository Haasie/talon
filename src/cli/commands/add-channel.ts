/**
 * `talonctl add-channel` command.
 *
 * Adds a new channel connector entry to talond.yaml. The entry is appended
 * to the `channels` array with the given name and type, and a placeholder
 * `config` object that the user can fill in.
 */

import {
  DEFAULT_CONFIG_PATH,
  VALID_CHANNEL_TYPES,
  validateName,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddChannelOptions {
  name: string;
  type: string;
  configPath?: string;
}

export interface AddChannelEntry {
  name: string;
  type: string;
  config: Record<string, unknown>;
  enabled: true;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Adds a channel to the config file.
 *
 * Pure business logic — no console output or process.exit.
 * Can be called from CLI, setup skill, or terminal agent.
 *
 * @returns The channel entry that was added.
 * @throws Error with a user-facing message on any failure.
 */
export async function addChannel(options: AddChannelOptions): Promise<AddChannelEntry> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  // Validate name.
  const nameError = validateName(options.name, 'Channel');
  if (nameError) {
    throw new Error(nameError);
  }

  // Validate type.
  if (!VALID_CHANNEL_TYPES.includes(options.type as (typeof VALID_CHANNEL_TYPES)[number])) {
    throw new Error(
      `Unknown channel type "${options.type}". Valid types: ${VALID_CHANNEL_TYPES.join(', ')}.`,
    );
  }

  // Read existing config.
  const doc = await readConfig(configPath);

  // Ensure channels array exists.
  if (!Array.isArray(doc.channels)) {
    doc.channels = [];
  }

  // Check for duplicate channel name.
  const duplicate = doc.channels.find((c) => c.name === options.name);
  if (duplicate) {
    throw new Error(
      `A channel named "${options.name}" already exists in "${configPath}". Choose a different name or edit the existing entry directly.`,
    );
  }

  // Build and append the new channel entry.
  const entry: AddChannelEntry = {
    name: options.name,
    type: options.type,
    config: buildPlaceholderConfig(options.type),
    enabled: true,
  };

  doc.channels.push(entry);

  // Write atomically.
  await writeConfigAtomic(configPath, doc);

  return entry;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl add-channel`.
 *
 * Thin wrapper around {@link addChannel} that prints output and exits.
 */
export async function addChannelCommand(options: AddChannelOptions): Promise<void> {
  try {
    const entry = await addChannel(options);
    console.log(`Added channel "${entry.name}" (type: ${entry.type}) to "${options.configPath ?? DEFAULT_CONFIG_PATH}".`);
    console.log(`Edit "${options.configPath ?? DEFAULT_CONFIG_PATH}" to fill in the channel credentials.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns a type-specific placeholder config object for the channel entry.
 * Exported for use by the setup skill preview flow.
 */
export function buildPlaceholderConfig(type: string): Record<string, unknown> {
  switch (type) {
    case 'telegram':
      return { token: 'YOUR_TELEGRAM_BOT_TOKEN' };
    case 'slack':
      return { botToken: 'YOUR_SLACK_BOT_TOKEN', appToken: 'YOUR_SLACK_APP_TOKEN' };
    case 'discord':
      return { token: 'YOUR_DISCORD_BOT_TOKEN' };
    case 'whatsapp':
      return { accountSid: 'YOUR_ACCOUNT_SID', authToken: 'YOUR_AUTH_TOKEN' };
    case 'email':
      return {
        imap: { host: 'mail.example.com', port: 993, user: 'user@example.com', password: 'PASSWORD' },
        smtp: { host: 'mail.example.com', port: 587, user: 'user@example.com', password: 'PASSWORD' },
      };
    case 'terminal':
      return { port: 7700, host: '0.0.0.0', token: '${TERMINAL_TOKEN}' };
    default:
      return {};
  }
}

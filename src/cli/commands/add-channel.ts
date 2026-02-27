/**
 * `talonctl add-channel` command.
 *
 * Adds a new channel connector entry to talond.yaml. The entry is appended
 * to the `channels` array with the given name and type, and a placeholder
 * `config` object that the user can fill in.
 *
 * Exits with an error if a channel with the same name already exists.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';

import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default config file path. */
const DEFAULT_CONFIG_PATH = 'talond.yaml';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape expected in the YAML channels array. */
interface ChannelEntry {
  name: string;
  type: string;
  config?: Record<string, unknown>;
  enabled?: boolean;
}

/** Root YAML document structure (partial — only what we need). */
interface YamlDocument {
  channels?: ChannelEntry[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `add-channel` CLI command.
 *
 * Reads the existing talond.yaml, validates uniqueness of the channel name,
 * appends a new channel entry, and writes the updated YAML back to disk.
 *
 * @param options.name       - Unique name for the channel (e.g. "my-telegram").
 * @param options.type       - Connector type (e.g. "telegram").
 * @param options.configPath - Path to talond.yaml (default: "talond.yaml").
 */
export async function addChannelCommand(options: {
  name: string;
  type: string;
  configPath?: string;
}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;

  if (!existsSync(configPath)) {
    console.error(`Error: config file "${configPath}" not found.`);
    console.error(`Run \`talonctl setup\` first, or pass --config to specify a different path.`);
    process.exit(1);
    return;
  }

  let rawContent: string;
  try {
    rawContent = await fs.readFile(configPath, 'utf-8');
  } catch (cause) {
    console.error(`Error reading config file "${configPath}": ${String(cause)}`);
    process.exit(1);
    return;
  }

  let doc: YamlDocument;
  try {
    const parsed = yaml.load(rawContent);
    doc = (parsed ?? {}) as YamlDocument;
  } catch (cause) {
    console.error(`Error parsing YAML in "${configPath}": ${String(cause)}`);
    process.exit(1);
    return;
  }

  // Ensure channels array exists.
  if (!Array.isArray(doc.channels)) {
    doc.channels = [];
  }

  // Check for duplicate channel name.
  const duplicate = doc.channels.find((c) => c.name === options.name);
  if (duplicate) {
    console.error(`Error: a channel named "${options.name}" already exists in "${configPath}".`);
    console.error(`Choose a different name or edit the existing channel entry directly.`);
    process.exit(1);
    return;
  }

  // Build the new channel entry with a type-specific placeholder config.
  const newChannel: ChannelEntry = {
    name: options.name,
    type: options.type,
    config: buildPlaceholderConfig(options.type),
    enabled: true,
  };

  doc.channels.push(newChannel);

  // Serialise the updated document back to YAML.
  const updatedYaml = yaml.dump(doc, {
    lineWidth: 120,
    quotingType: '"',
    forceQuotes: false,
  });

  try {
    await fs.writeFile(configPath, updatedYaml, 'utf-8');
  } catch (cause) {
    console.error(`Error writing config file "${configPath}": ${String(cause)}`);
    process.exit(1);
    return;
  }

  console.log(`Added channel "${options.name}" (type: ${options.type}) to "${configPath}".`);
  console.log(`Edit "${configPath}" to fill in the channel credentials.`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns a type-specific placeholder config object for the channel entry.
 *
 * Provides sensible field names so the user knows what to fill in.
 */
function buildPlaceholderConfig(type: string): Record<string, unknown> {
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
    default:
      return {};
  }
}

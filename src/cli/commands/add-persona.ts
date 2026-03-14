/**
 * `talonctl add-persona` command.
 *
 * Scaffolds a new persona directory and registers it in talond.yaml.
 *
 * Creates:
 *   personas/{name}/
 *   personas/{name}/system.md              — default system prompt template
 *   personas/{name}/personality/01-tone.md — example personality file
 *
 * Adds a persona entry to the `personas` array in talond.yaml with:
 *   - name
 *   - model (default: claude-sonnet-4-6)
 *   - systemPromptFile pointing to the created system.md
 *   - empty skills list
 *   - empty capabilities
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CONFIG_PATH,
  validateName,
  readConfig,
  writeConfigAtomic,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default model for newly created personas. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddPersonaOptions {
  name: string;
  configPath?: string;
  personasDir?: string;
}

export interface AddPersonaEntry {
  name: string;
  model: string;
  systemPromptFile: string;
  skills: string[];
  capabilities: { allow: string[]; requireApproval: string[] };
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Adds a persona to the config file and scaffolds its directory.
 *
 * Pure business logic — no console output or process.exit.
 * Can be called from CLI, setup skill, or terminal agent.
 *
 * @returns The persona entry that was added.
 * @throws Error with a user-facing message on any failure.
 */
export async function addPersona(options: AddPersonaOptions): Promise<AddPersonaEntry> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const personasDir = options.personasDir ?? 'personas';

  // Validate name.
  const nameError = validateName(options.name, 'Persona');
  if (nameError) {
    throw new Error(nameError);
  }

  // Read existing config.
  const doc = await readConfig(configPath);

  // Ensure personas array exists.
  if (!Array.isArray(doc.personas)) {
    doc.personas = [];
  }

  // Check for duplicate persona name.
  const duplicate = doc.personas.find((p) => p.name === options.name);
  if (duplicate) {
    throw new Error(
      `A persona named "${options.name}" already exists in "${configPath}". Choose a different name or edit the existing entry directly.`,
    );
  }

  // Scaffold persona directory.
  const personaDir = path.join(personasDir, options.name);
  const systemPromptFile = path.join(personaDir, 'system.md');

  try {
    await fs.mkdir(personaDir, { recursive: true });
  } catch (cause) {
    throw new Error(`Error creating persona directory "${personaDir}": ${String(cause)}`);
  }

  // Write system prompt template and personality scaffold only for new personas.
  const isNewPersona = !existsSync(systemPromptFile);
  if (isNewPersona) {
    try {
      await fs.writeFile(systemPromptFile, buildSystemPromptTemplate(options.name), 'utf-8');
    } catch (cause) {
      throw new Error(`Error writing system prompt file "${systemPromptFile}": ${String(cause)}`);
    }

    // Scaffold personality folder with example file.
    const personalityDir = path.join(personaDir, 'personality');
    const promptsDir = path.join(personaDir, 'prompts');
    try {
      await fs.mkdir(personalityDir, { recursive: true });
      await fs.mkdir(promptsDir, { recursive: true });
      await fs.writeFile(path.join(personalityDir, '01-tone.md'), buildExamplePersonalityFile(), 'utf-8');
    } catch (cause) {
      throw new Error(`Error scaffolding persona folders (personality/prompts): ${String(cause)}`);
    }
  }

  // Build persona entry.
  const entry: AddPersonaEntry = {
    name: options.name,
    model: DEFAULT_MODEL,
    systemPromptFile,
    skills: [],
    capabilities: {
      allow: [],
      requireApproval: [],
    },
  };

  doc.personas.push(entry);

  // Write atomically.
  await writeConfigAtomic(configPath, doc);

  return entry;
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

/**
 * CLI entrypoint for `talonctl add-persona`.
 *
 * Thin wrapper around {@link addPersona} that prints output and exits.
 */
export async function addPersonaCommand(options: AddPersonaOptions): Promise<void> {
  try {
    const entry = await addPersona(options);
    console.log(`Created persona directory: ${path.dirname(entry.systemPromptFile)}`);
    console.log(`Created system prompt:     ${entry.systemPromptFile}`);
    console.log(`Created personality folder: ${path.join(path.dirname(entry.systemPromptFile), 'personality')}`);
    console.log(`Created prompts folder:    ${path.join(path.dirname(entry.systemPromptFile), 'prompts')}`);
    console.log(`Added persona "${entry.name}" to "${options.configPath ?? DEFAULT_CONFIG_PATH}".`);
    console.log(`Edit "${entry.systemPromptFile}" to customise the system prompt.`);
    console.log(`Add .md files to the personality/ folder to enhance the agent's personality.`);
    console.log(`Add task-specific prompts to the prompts/ folder and reference them with promptFile in schedules.`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns an example personality file to get users started.
 */
function buildExamplePersonalityFile(): string {
  return [
    '# Tone & Style',
    '',
    '<!-- This file is optional. Add as many .md files as you like to this folder. -->',
    '<!-- They are loaded alphabetically and appended to the system prompt. -->',
    '<!-- Delete this file or edit it to match your agent\'s personality. -->',
    '',
    '- Be concise and direct.',
    '- Use a professional but approachable tone.',
    '- Avoid jargon unless the user uses it first.',
    '',
  ].join('\n');
}

/**
 * Returns a default system prompt markdown template for the given persona name.
 */
export function buildSystemPromptTemplate(name: string): string {
  return [
    `# ${name} — System Prompt`,
    '',
    `You are ${name}, a helpful AI assistant.`,
    '',
    '## Behaviour',
    '',
    '- Be concise and accurate.',
    '- Reply in clear, plain language.',
    '- Ask for clarification when the request is ambiguous.',
    '',
    '## Constraints',
    '',
    '- Do not reveal confidential system information.',
    '- Decline requests that violate safety guidelines.',
    '',
    '<!-- Add task-specific prompt files under prompts/*.md and reference them from schedules via promptFile. -->',
    '',
  ].join('\n');
}

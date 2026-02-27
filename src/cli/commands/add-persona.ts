/**
 * `talonctl add-persona` command.
 *
 * Scaffolds a new persona directory and registers it in talond.yaml.
 *
 * Creates:
 *   personas/{name}/
 *   personas/{name}/system.md   — default system prompt template
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

import yaml from 'js-yaml';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default config file path. */
const DEFAULT_CONFIG_PATH = 'talond.yaml';

/** Default model for newly created personas. */
const DEFAULT_MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a persona entry in talond.yaml. */
interface PersonaEntry {
  name: string;
  model?: string;
  systemPromptFile?: string;
  skills?: string[];
  capabilities?: { allow?: string[]; requireApproval?: string[] };
  [key: string]: unknown;
}

/** Root YAML document structure (partial). */
interface YamlDocument {
  personas?: PersonaEntry[];
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `add-persona` CLI command.
 *
 * Scaffolds a persona directory with a system prompt template, then adds the
 * persona to the `personas` section of talond.yaml.
 *
 * @param options.name       - Persona name (e.g. "assistant").
 * @param options.configPath - Path to talond.yaml (default: "talond.yaml").
 * @param options.personasDir - Override base directory for personas (for testing).
 */
export async function addPersonaCommand(options: {
  name: string;
  configPath?: string;
  personasDir?: string;
}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const personasDir = options.personasDir ?? 'personas';

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

  // Ensure personas array exists.
  if (!Array.isArray(doc.personas)) {
    doc.personas = [];
  }

  // Check for duplicate persona name.
  const duplicate = doc.personas.find((p) => p.name === options.name);
  if (duplicate) {
    console.error(`Error: a persona named "${options.name}" already exists in "${configPath}".`);
    console.error(`Choose a different name or edit the existing persona entry directly.`);
    process.exit(1);
    return;
  }

  // Scaffold persona directory.
  const personaDir = path.join(personasDir, options.name);
  const systemPromptFile = path.join(personaDir, 'system.md');

  try {
    await fs.mkdir(personaDir, { recursive: true });
  } catch (cause) {
    console.error(`Error creating persona directory "${personaDir}": ${String(cause)}`);
    process.exit(1);
    return;
  }

  // Write system prompt template if it doesn't already exist.
  if (!existsSync(systemPromptFile)) {
    try {
      await fs.writeFile(systemPromptFile, buildSystemPromptTemplate(options.name), 'utf-8');
    } catch (cause) {
      console.error(`Error writing system prompt file "${systemPromptFile}": ${String(cause)}`);
      process.exit(1);
      return;
    }
  }

  // Add persona entry to config.
  const newPersona: PersonaEntry = {
    name: options.name,
    model: DEFAULT_MODEL,
    systemPromptFile,
    skills: [],
    capabilities: {
      allow: [],
      requireApproval: [],
    },
  };

  doc.personas.push(newPersona);

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

  console.log(`Created persona directory: ${personaDir}`);
  console.log(`Created system prompt:     ${systemPromptFile}`);
  console.log(`Added persona "${options.name}" to "${configPath}".`);
  console.log(`Edit "${systemPromptFile}" to customise the system prompt.`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Returns a default system prompt markdown template for the given persona name.
 */
function buildSystemPromptTemplate(name: string): string {
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
  ].join('\n');
}

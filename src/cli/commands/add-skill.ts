/**
 * `talonctl add-skill` command.
 *
 * Scaffolds a new skill directory structure and registers the skill with a
 * persona in talond.yaml.
 *
 * Creates:
 *   skills/{name}/
 *   skills/{name}/skill.yaml     — skill manifest stub
 *   skills/{name}/prompts/       — prompts directory
 *
 * Updates talond.yaml:
 *   - Adds the skill name to the specified persona's `skills` list.
 *   - Exits with an error if the persona does not exist.
 *   - Exits with an error if the skill is already registered on the persona.
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Shape of a persona entry in talond.yaml (relevant fields). */
interface PersonaEntry {
  name: string;
  skills?: string[];
  [key: string]: unknown;
}

/** Root YAML document structure (partial). */
interface YamlDocument {
  personas?: PersonaEntry[];
  [key: string]: unknown;
}

/** Skill manifest shape written to skill.yaml. */
interface SkillManifest {
  name: string;
  version: string;
  description: string;
  prompts: string[];
  capabilities: { allow: string[]; requireApproval: string[] };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Executes the `add-skill` CLI command.
 *
 * Scaffolds a skill directory, creates a stub skill.yaml manifest, and adds
 * the skill to the specified persona's skills list in talond.yaml.
 *
 * @param options.name        - Skill name (e.g. "web-search").
 * @param options.personaName - Name of the persona to attach the skill to.
 * @param options.configPath  - Path to talond.yaml (default: "talond.yaml").
 * @param options.skillsDir   - Override base directory for skills (for testing).
 */
export async function addSkillCommand(options: {
  name: string;
  personaName: string;
  configPath?: string;
  skillsDir?: string;
}): Promise<void> {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const skillsDir = options.skillsDir ?? 'skills';

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

  // Find the target persona.
  const persona = doc.personas.find((p) => p.name === options.personaName);
  if (!persona) {
    console.error(
      `Error: persona "${options.personaName}" not found in "${configPath}".`,
    );
    console.error(
      `Run \`talonctl add-persona --name ${options.personaName}\` to create it first.`,
    );
    process.exit(1);
    return;
  }

  // Ensure persona has a skills array.
  if (!Array.isArray(persona.skills)) {
    persona.skills = [];
  }

  // Check if skill is already registered on this persona.
  if (persona.skills.includes(options.name)) {
    console.error(
      `Error: skill "${options.name}" is already registered on persona "${options.personaName}".`,
    );
    process.exit(1);
    return;
  }

  // Scaffold skill directory.
  const skillDir = path.join(skillsDir, options.name);
  const promptsDir = path.join(skillDir, 'prompts');
  const manifestPath = path.join(skillDir, 'skill.yaml');

  try {
    await fs.mkdir(promptsDir, { recursive: true });
  } catch (cause) {
    console.error(`Error creating skill directory "${promptsDir}": ${String(cause)}`);
    process.exit(1);
    return;
  }

  // Write skill manifest stub if it doesn't already exist.
  if (!existsSync(manifestPath)) {
    const manifest: SkillManifest = buildSkillManifest(options.name);
    const manifestYaml = yaml.dump(manifest, {
      lineWidth: 120,
      quotingType: '"',
      forceQuotes: false,
    });

    const header = [
      `# skill.yaml — ${options.name} skill manifest`,
      '# Edit this file to configure the skill.',
      '',
      '',
    ].join('\n');

    try {
      await fs.writeFile(manifestPath, header + manifestYaml, 'utf-8');
    } catch (cause) {
      console.error(`Error writing skill manifest "${manifestPath}": ${String(cause)}`);
      process.exit(1);
      return;
    }
  }

  // Register skill on persona.
  persona.skills.push(options.name);

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

  console.log(`Created skill directory:  ${skillDir}`);
  console.log(`Created prompts directory: ${promptsDir}`);
  console.log(`Created skill manifest:   ${manifestPath}`);
  console.log(
    `Added skill "${options.name}" to persona "${options.personaName}" in "${configPath}".`,
  );
  console.log(`Edit "${manifestPath}" to configure the skill.`);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Builds a stub skill manifest object for the given skill name.
 */
function buildSkillManifest(name: string): SkillManifest {
  return {
    name,
    version: '0.1.0',
    description: `${name} skill — replace this with a meaningful description.`,
    prompts: [],
    capabilities: {
      allow: [],
      requireApproval: [],
    },
  };
}

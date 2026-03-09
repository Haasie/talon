/**
 * `talonctl add-mcp` command.
 *
 * Adds an MCP server definition to a skill's mcp/ directory.
 * Creates the directory structure if needed.
 */

import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

import {
  validateName,
} from '../config-utils.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddMcpOptions {
  skillName: string;
  name: string;
  transport: 'stdio' | 'sse' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  skillsDir?: string;
}

export interface AddMcpResult {
  name: string;
  skillName: string;
  mcpConfigPath: string;
}

// ---------------------------------------------------------------------------
// Core logic (importable)
// ---------------------------------------------------------------------------

/**
 * Adds an MCP server definition to a skill.
 *
 * Creates `skills/{skillName}/mcp/{name}.json` with the server config.
 * Verifies the skill directory exists on disk.
 *
 * @throws Error on validation failures or filesystem errors.
 */
export async function addMcp(options: AddMcpOptions): Promise<AddMcpResult> {
  const skillsDir = options.skillsDir ?? 'skills';

  // Validate names.
  const nameError = validateName(options.name, 'MCP server');
  if (nameError) throw new Error(nameError);
  const skillError = validateName(options.skillName, 'Skill');
  if (skillError) throw new Error(skillError);

  // Validate transport value.
  const validTransports = ['stdio', 'sse', 'http'] as const;
  if (!validTransports.includes(options.transport as (typeof validTransports)[number])) {
    throw new Error(`Invalid transport "${options.transport}". Must be one of: ${validTransports.join(', ')}.`);
  }

  // Validate transport-specific requirements.
  if (options.transport === 'stdio' && !options.command) {
    throw new Error('--command is required for stdio transport.');
  }
  if ((options.transport === 'sse' || options.transport === 'http') && !options.url) {
    throw new Error('--url is required for sse/http transport.');
  }

  // Verify skill directory exists.
  const skillDir = path.join(skillsDir, options.skillName);
  if (!existsSync(skillDir)) {
    throw new Error(
      `Skill directory "${skillDir}" not found. Run \`talonctl add-skill --name ${options.skillName} --persona <persona>\` first.`,
    );
  }

  // Create mcp/ directory if needed.
  const mcpDir = path.join(skillDir, 'mcp');
  await fs.mkdir(mcpDir, { recursive: true });

  // Check if MCP config already exists.
  const mcpConfigPath = path.join(mcpDir, `${options.name}.json`);
  if (existsSync(mcpConfigPath)) {
    throw new Error(`MCP server "${options.name}" already exists at "${mcpConfigPath}".`);
  }

  // Build the MCP server definition.
  const mcpDef: Record<string, unknown> = {
    name: options.name,
    config: {
      transport: options.transport,
      ...(options.command ? { command: options.command } : {}),
      ...(options.args && options.args.length > 0 ? { args: options.args } : {}),
      ...(options.url ? { url: options.url } : {}),
      ...(options.env && Object.keys(options.env).length > 0 ? { env: options.env } : {}),
    },
  };

  await fs.writeFile(mcpConfigPath, JSON.stringify(mcpDef, null, 2) + '\n', 'utf-8');

  return {
    name: options.name,
    skillName: options.skillName,
    mcpConfigPath,
  };
}

// ---------------------------------------------------------------------------
// CLI wrapper
// ---------------------------------------------------------------------------

export async function addMcpCommand(options: AddMcpOptions): Promise<void> {
  try {
    const result = await addMcp(options);
    console.log(`Created MCP server config: ${result.mcpConfigPath}`);
    console.log(`Added MCP server "${result.name}" to skill "${result.skillName}".`);
  } catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exit(1);
  }
}

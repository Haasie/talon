/**
 * Skills system — reusable, named capability bundles for personas.
 *
 * Skills are defined as directories containing a manifest (skill.yaml),
 * prompt fragments, tool manifests, MCP server definitions, and optional
 * SQL migrations.
 *
 * Main exports:
 *   - {@link SkillLoader}    — reads skill directories from the filesystem.
 *   - {@link SkillResolver}  — resolves which skills are usable for a persona.
 *   - {@link SkillManifestSchema} — Zod schema for skill.yaml validation.
 *   - Type re-exports for consumers.
 */

export { SkillLoader } from './skill-loader.js';
export { SkillResolver } from './skill-resolver.js';
export { SkillManifestSchema } from './skill-schema.js';
export type { SkillManifestInput, SkillManifestOutput } from './skill-schema.js';
export type {
  SkillManifest,
  McpServerDef,
  LoadedSkill,
  ResolvedSkillSet,
  SkillDirectory,
} from './skill-types.js';

/**
 * SkillResolver — pure function layer that determines which skills are
 * usable for a given persona and merges their contributions.
 *
 * A skill is usable if ALL of its `requiredCapabilities` are present in
 * the persona's effective capability set (the union of `allow` and
 * `requireApproval` lists). Skills with zero required capabilities are
 * always usable.
 *
 * The resolver is stateless: it takes data in and returns data out with
 * no file I/O, database access, or other side effects.
 */

import { ok, err, type Result } from 'neverthrow';
import type pino from 'pino';
import { SkillError } from '../core/errors/index.js';
import type { LoadedSkill, McpServerDef, ResolvedSkillSet } from './skill-types.js';
import type { ToolManifest } from '../tools/tool-types.js';

// ---------------------------------------------------------------------------
// SkillResolver
// ---------------------------------------------------------------------------

/**
 * Resolves which skills are usable for a persona based on its declared skill
 * names and effective capability set.
 */
export class SkillResolver {
  constructor(private readonly logger: pino.Logger) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Resolves the usable skill set for a persona.
   *
   * Algorithm:
   *   1. Find each `personaSkillName` in `allSkills`. Track unknown names.
   *   2. For each found skill, check whether ALL `requiredCapabilities` are
   *      present in `personaCapabilities` (union of allow + requireApproval).
   *      If any capability is missing the skill is moved to `skipped`.
   *   3. Return the {@link ResolvedSkillSet} describing usable, skipped, and
   *      unknown skills.
   *
   * @param personaSkillNames    - Names declared in the persona's `skills` list.
   * @param allSkills            - All loaded skills available in the system.
   * @param personaCapabilities  - Combined allow + requireApproval labels for
   *                               the persona (from {@link ResolvedCapabilities}).
   * @returns `Ok(ResolvedSkillSet)` always (the resolver never hard-fails;
   *          problems are captured in `skipped` and `unknown` fields).
   */
  resolveForPersona(
    personaSkillNames: string[],
    allSkills: LoadedSkill[],
    personaCapabilities: string[],
  ): Result<ResolvedSkillSet, SkillError> {
    const skillByName = new Map<string, LoadedSkill>(
      allSkills.map((s) => [s.manifest.name, s]),
    );

    const capabilitySet = new Set(personaCapabilities);
    const usable: LoadedSkill[] = [];
    const skipped: ResolvedSkillSet['skipped'] = [];
    const unknown: string[] = [];

    for (const name of personaSkillNames) {
      const skill = skillByName.get(name);

      if (!skill) {
        this.logger.warn({ skillName: name }, 'persona references unknown skill');
        unknown.push(name);
        continue;
      }

      const missing = skill.manifest.requiredCapabilities.filter(
        (cap) => !capabilitySet.has(cap),
      );

      if (missing.length > 0) {
        this.logger.debug(
          { skill: name, missingCapabilities: missing },
          'skill skipped: missing required capabilities',
        );
        skipped.push({ skillName: name, missingCapabilities: missing });
        continue;
      }

      usable.push(skill);
      this.logger.debug({ skill: name }, 'skill resolved as usable');
    }

    return ok({ usable, skipped, unknown });
  }

  /**
   * Concatenates prompt fragments from all resolved skills into a single
   * string, separated by newlines.
   *
   * Fragment order within each skill is the order returned by the loader
   * (alphabetical by filename). Skills are processed in the order given.
   *
   * @param skills - Skills whose prompt fragments should be merged.
   * @returns Merged prompt string (empty string when no fragments exist).
   */
  mergePromptFragments(skills: LoadedSkill[]): string {
    const fragments: string[] = [];

    for (const skill of skills) {
      fragments.push(...skill.promptContents);
    }

    return fragments.join('\n');
  }

  /**
   * Collects all tool manifests from the given resolved skills.
   *
   * Tool manifests are gathered in skill order (the order of the `skills`
   * array). Within each skill they appear in the order the loader returned
   * them (alphabetical by filename).
   *
   * Duplicate tool names across skills are included as-is; deduplication
   * is the caller's responsibility.
   *
   * @param skills - Resolved skills to gather tool manifests from.
   * @returns Array of all tool manifests.
   */
  collectToolManifests(skills: LoadedSkill[]): ToolManifest[] {
    const manifests: ToolManifest[] = [];

    for (const skill of skills) {
      manifests.push(...skill.resolvedToolManifests);
    }

    return manifests;
  }

  /**
   * Collects all MCP server definitions from the given resolved skills.
   *
   * Server defs are gathered in skill order. Duplicate server names across
   * skills are included as-is; deduplication is the caller's responsibility.
   *
   * @param skills - Resolved skills to gather MCP server defs from.
   * @returns Array of all MCP server definitions.
   */
  collectMcpServers(skills: LoadedSkill[]): McpServerDef[] {
    const servers: McpServerDef[] = [];

    for (const skill of skills) {
      servers.push(...skill.resolvedMcpServers);
    }

    return servers;
  }
}

/**
 * Capability resolution and validation utilities.
 *
 * Capability labels follow the pattern `<domain>.<action>:<scope>` where:
 *   - `domain`  — resource category  (e.g. `fs`, `net`, `channel`, `memory`)
 *   - `action`  — operation type     (e.g. `read`, `write`, `http`, `send`)
 *   - `scope`   — narrowing qualifier (e.g. `workspace`, `egress`, `telegram`)
 *
 * Examples:
 *   - `fs.read:workspace`
 *   - `net.http:egress`
 *   - `channel.send:telegram`
 *   - `memory.write:thread`
 *
 * The resolver computes which capabilities are _granted_ (intersection of
 * persona allowlist and skill requirements) and which are _unmet_ (skill
 * requirements not covered by the allowlist).
 */

// ---------------------------------------------------------------------------
// Capability label validation
// ---------------------------------------------------------------------------

/**
 * Regular expression for a valid capability label.
 *
 * Pattern: `<word>.<word>:<word>` — each segment is one or more word
 * characters (`[a-zA-Z0-9_]`), separated by `.` between domain and action,
 * and `:` between action and scope.
 */
const CAPABILITY_LABEL_RE = /^\w+\.\w+:\w+$/;

/**
 * Check whether a string is a well-formed capability label.
 *
 * Valid form: `<domain>.<action>:<scope>` — all segments must be non-empty
 * and contain only word characters (`[a-zA-Z0-9_]`).
 *
 * @param label - The string to validate.
 * @returns `true` if the label matches the expected pattern.
 *
 * @example
 * isValidCapabilityLabel('fs.read:workspace') // true
 * isValidCapabilityLabel('net.http:egress')   // true
 * isValidCapabilityLabel('fs.read')           // false — missing scope
 * isValidCapabilityLabel('')                  // false
 */
export function isValidCapabilityLabel(label: string): boolean {
  return CAPABILITY_LABEL_RE.test(label);
}

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

/**
 * Result of resolving capabilities for a persona + skill combination.
 */
export interface ResolvedCapabilities {
  /**
   * Capability labels that are both in the persona allowlist and required by
   * at least one skill — these are active for the current run.
   */
  granted: string[];
  /**
   * Capability labels required by skills that are NOT in the persona
   * allowlist — these skills cannot be used until the persona is updated.
   */
  unmet: string[];
}

/**
 * Resolve the effective granted capabilities for a run.
 *
 * Granted = intersection of `personaAllow` and `skillRequired`.
 * Unmet   = `skillRequired` minus `personaAllow`.
 *
 * Duplicates in either input are handled correctly — the output arrays
 * contain each label at most once.
 *
 * @param personaAllow  - Capability labels explicitly allowed by the persona config.
 * @param skillRequired - Capability labels required by the loaded skills.
 * @returns Object with `granted` and `unmet` arrays.
 *
 * @example
 * resolveCapabilities(
 *   ['fs.read:workspace', 'net.http:egress'],
 *   ['fs.read:workspace', 'channel.send:telegram'],
 * )
 * // => { granted: ['fs.read:workspace'], unmet: ['channel.send:telegram'] }
 */
export function resolveCapabilities(
  personaAllow: string[],
  skillRequired: string[],
): ResolvedCapabilities {
  const allowSet = new Set(personaAllow);
  const requiredSet = new Set(skillRequired);

  const granted: string[] = [];
  const unmet: string[] = [];

  for (const cap of requiredSet) {
    if (allowSet.has(cap)) {
      granted.push(cap);
    } else {
      unmet.push(cap);
    }
  }

  return { granted, unmet };
}

// ---------------------------------------------------------------------------
// Capability check
// ---------------------------------------------------------------------------

/**
 * Check whether a specific capability is present in a granted set.
 *
 * This is a simple membership test against the pre-resolved `granted` array
 * from {@link resolveCapabilities}. It intentionally does not perform any
 * wildcard or prefix matching — labels must match exactly.
 *
 * @param granted  - Array of granted capability labels.
 * @param required - The single capability label to check for.
 * @returns `true` if `required` appears in `granted`.
 *
 * @example
 * hasCapability(['fs.read:workspace', 'net.http:egress'], 'fs.read:workspace') // true
 * hasCapability(['fs.read:workspace'], 'fs.write:workspace')                   // false
 */
export function hasCapability(granted: string[], required: string): boolean {
  return granted.includes(required);
}

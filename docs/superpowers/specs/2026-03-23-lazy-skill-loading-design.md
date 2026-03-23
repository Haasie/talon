# Lazy Skill Loading (Metadata-Only Until Invoked)

**Issue:** [#90](https://github.com/ivo-toby/talon/issues/90)
**Date:** 2026-03-23
**Branch:** `feat/lazy-skill-loading`

## Problem

Talon loads all prompt fragments from all attached skills into every agent run's system prompt. A persona with 7 skills pays ~21k tokens per run even when no skills are needed. This wastes tokens and pollutes context.

## Solution

Implement lazy skill loading with a three-tier progressive disclosure model:

1. **Metadata** (always in system prompt): skill name + description (~100 tokens per skill)
2. **Instructions** (loaded on demand): full prompt content, only when the agent calls `skill_load`
3. **Resources** (unchanged): MCP servers from skills still connect eagerly at startup

### Token Impact

| Scenario | Before | After |
|---|---|---|
| 7 skills, using 1 | ~21k tokens | ~3.7k tokens |
| 20 skills, using 0 | ~60k tokens | ~2k tokens |

## Design

### 1. Dual Skill Format Support

Support two on-disk formats that both produce the same `LoadedSkill` type.

**Existing format** (`skill.yaml` + `prompts/*.md`):
```
skills/codex/
  skill.yaml
  prompts/main.md
  mcp/codex.json
```

**New SKILL.md format** (single file with YAML frontmatter):
```
skills/web-research/
  SKILL.md
  mcp/              # optional
  tools/            # optional
  migrations/       # optional
```

SKILL.md example:
```markdown
---
name: web-research
version: 0.1.0
description: "Search the web and fetch pages for research tasks"
requiredCapabilities:
  - net.http:external
---

# Web Research

Instructions for the agent on how to use this skill...
```

**Detection logic in `SkillLoader`:**
- Directory contains `SKILL.md` → parse frontmatter as manifest, markdown body as prompt content
- Directory contains `skill.yaml` → current behavior (read prompts from `prompts/*.md`)
- Both exist → error (ambiguous format)

**Schema:** Frontmatter reuses `SkillManifestSchema` with `version` defaulting to `"0.1.0"` and `promptFragments` field ignored (the body IS the prompt).

**`LoadedSkill` type:** Add `format: 'yaml' | 'skillmd'` field. Everything downstream operates on `LoadedSkill` unchanged. Normalize loader-internal comments and variable names that are `skill.yaml`-centric to be format-neutral.

**Note on skill resolution:** Currently `AgentRunner` filters `loadedSkills` by configured name without calling `SkillResolver.resolveForPersona()` (which checks `requiredCapabilities`). This means skills with unsatisfied capabilities can appear in the skill index and content map. Fixing this pre-existing gap is out of scope for this issue but should be tracked separately. For now, the lazy loading implementation will operate on the same set of skills that the current eager loading uses.

### 2. System Prompt — Metadata Index

Replace full prompt injection with a compact skill index.

**Changes to `persona-runtime-context.ts`:**

New function `buildSkillIndex(resolvedSkills: LoadedSkill[]): string` generates:

```
## Available Skills
- **codex**: Run OpenAI Codex CLI for code analysis, refactoring, and automated editing
- **web-research**: Search the web and fetch pages for research tasks
- **home-assistant**: Control smart home devices via Home Assistant

To use a skill, call the `skill_load` tool with the skill name. The tool returns the full instructions for that skill.
```

`buildPersonaRuntimeContext` accepts a new option `skillLoadingMode: 'lazy' | 'eager'` (default: `'lazy'`). When `'lazy'`, it calls `buildSkillIndex`; when `'eager'`, it calls `mergePromptFragments` (current behavior). This preserves backwards compatibility and is needed for background agents (see below).

The old `mergePromptFragments` method stays on `SkillResolver` (not deleted).

MCP server collection is unaffected — servers from skills still get wired up eagerly.

**Background agents:** Background agents (spawned via `background-agent-manager.ts`) reuse `buildPersonaRuntimeContext` but run through their own provider invocation path without the `skill_load` tool interception or MCP fallback. Background agents MUST use `skillLoadingMode: 'eager'` so they receive full skill prompts. This is acceptable because background agents are typically short-lived, single-purpose tasks where the token overhead of eager loading is less impactful than missing skill instructions.

### 3. `skill_load` Tool — Claude SDK (Native)

For the Claude Agent SDK provider (strategy type `'sdk'`), `skill_load` is a native tool handled directly by the agent-runner with zero subprocess overhead.

**Provider API change required:** Currently `AgentRunner` passes `AgentRunInput` to the provider, and `ClaudeCodeProvider` owns the SDK `query()` call internally. The agent-runner's event loop only observes `tool_event`s — it has no mechanism to inject tool definitions or send tool results back into the live SDK stream.

To support native tool interception, we widen the provider interface:

- Add an optional `customTools` field to `ProviderSpawnInput`: an array of `{ name, description, inputSchema, handler }` objects. The provider is responsible for injecting these tool definitions into its SDK call and routing tool calls back to the handler.
- `ClaudeCodeProvider` implements this by adding the custom tool definitions to the `query()` call and intercepting tool use blocks before yielding events. When a custom tool is called, it invokes the handler and feeds the result back into the conversation.
- Providers that don't support custom tools (Gemini CLI) ignore this field — they get the MCP fallback instead.

**Implementation in `agent-runner.ts`:**

1. **Skill content map:** At run start, build `Map<string, string>` from resolved skills (skill name → concatenated prompt content).

2. **Custom tool definition:** Create a `skill_load` custom tool:
   - Name: `skill_load`
   - Description: "Load the full instructions for a skill. Pass the skill name exactly as shown in Available Skills."
   - Input schema: `{ name: { type: "string", description: "Skill name" } }`
   - Handler: looks up skill name in the content map, returns prompt content or error

3. **Pass to provider:** Include `skill_load` in `customTools` on `ProviderSpawnInput`. The provider handles interception internally.

4. **Logging:** Log `skill.loaded` event with skill name and run ID when a skill is lazily loaded.

### 4. `skill_load` Tool — Gemini CLI (MCP Fallback)

For CLI-based providers (Gemini, future Codex), `skill_load` is served via a lightweight MCP server.

**New file: `src/tools/skill-loader-mcp-server.ts`** (~60 lines)

- Stdio MCP server exposing one tool: `skill_load({ name: string })`
- Receives skill content map via `TALOND_SKILL_MAP` env var (JSON-encoded `Record<string, string>`)
- Returns prompt content for the requested skill name, or error if not found

**Injection in agent-runner:**
- When strategy type is `'cli'`, inject a `__talond_skill_loader` entry into the `mcpServers` map
- Points to `dist/tools/skill-loader-mcp-server.js` with `TALOND_SKILL_MAP` env var
- When strategy type is `'sdk'`, this MCP server is NOT injected (native interception handles it)
- The `__talond_` prefix is reserved for internal MCP servers to prevent collision with user-defined servers. Validation in `persona-runtime-context.ts` should reject user-defined MCP servers with this prefix.

**Size:** With 20 skills at ~3K tokens each, the JSON env var payload is ~60KB — well within Linux's ~128KB env var limit.

### 5. CLI Changes

**`add-skill` command:**
- New `--format <yaml|skillmd>` option (default: `yaml` for backwards compatibility)
- When `skillmd`: create `skills/{name}/SKILL.md` with frontmatter stub instead of `skill.yaml` + `prompts/` directory
- Stub template:
  ```markdown
  ---
  name: <skill-name>
  version: 0.1.0
  description: "<skill-name> — replace with a meaningful description."
  ---

  # <skill-name>

  Replace this with skill instructions.
  ```

**`list-skills` command:**
- Add a FORMAT column showing `yaml` or `skillmd` per skill

### 6. `talon-setup` Skill Update

Update `.claude/skills/talon-setup/SKILL.md`:
- Returning-user menu option "Add a skill" mentions both formats
- Default recommendation for new skills: `skillmd` format
- Update skill directory structure references to show both layouts

## Files Changed

| File | Change |
|------|--------|
| `src/skills/skill-loader.ts` | SKILL.md detection + frontmatter parsing; ambiguity error |
| `src/skills/skill-schema.ts` | Frontmatter schema variant |
| `src/skills/skill-types.ts` | Add `format` field to `LoadedSkill` |
| `src/personas/persona-runtime-context.ts` | Add `buildSkillIndex`, `skillLoadingMode` option, `__talond_` prefix validation |
| `src/providers/provider-types.ts` | Add `customTools` field to `ProviderSpawnInput` |
| `src/providers/claude-code-provider.ts` | Implement `customTools` injection + interception in SDK query |
| `src/daemon/agent-runner.ts` | Skill content map, custom tool definition, MCP fallback injection, eager mode for background agents |
| `src/subagents/background/background-agent-manager.ts` | Pass `skillLoadingMode: 'eager'` to `buildPersonaRuntimeContext` |
| `src/tools/skill-loader-mcp-server.ts` | **New** — stdio MCP server for CLI providers |
| `src/cli/commands/add-skill.ts` | `--format` flag, SKILL.md stub generation |
| `src/cli/commands/list-skills.ts` | FORMAT column |
| `.claude/skills/talon-setup/SKILL.md` | Updated skill creation guidance |

## Files NOT Changed

- `src/skills/skill-resolver.ts` — operates on `LoadedSkill`, format-agnostic
- `src/personas/capability-merger.ts` — unaffected
- `src/tools/tool-filter.ts` — `skill_load` is not capability-gated
- `src/tools/host-tools-bridge.ts` — `skill_load` doesn't go through the bridge
- Database schema — no new tables or columns
- Config schema — no new config fields

## GPT-5.4 Review Findings (addressed)

1. **Critical — Background agents broken:** Fixed by adding `skillLoadingMode: 'eager' | 'lazy'` to `buildPersonaRuntimeContext`. Background agents use eager mode.
2. **High — Native tool interception doesn't fit provider boundary:** Fixed by widening provider API with `customTools` field on `ProviderSpawnInput`. `ClaudeCodeProvider` implements interception; CLI providers ignore it and get MCP fallback.
3. **High — `resolveForPersona()` not called at runtime:** Acknowledged as pre-existing gap, out of scope. Documented for separate tracking.
4. **Medium — MCP server name collision:** Fixed by using `__talond_` prefix for internal MCP servers with validation to reject user-defined servers using the prefix.
5. **Low — Loader comments/types are yaml-centric:** Will normalize during implementation.

## Acceptance Criteria

- [ ] Only skill name + description injected into system prompt per run
- [ ] Full skill prompt content loaded only when agent calls `skill_load` tool
- [ ] MCP servers from skills still connect at startup (tools available immediately)
- [ ] Token usage per run drops significantly when skills are not invoked
- [ ] Existing skills continue to work (agent can still use codex, web-research, etc.)
- [ ] Logs show which skills were lazily loaded per run
- [ ] Both `skill.yaml` and `SKILL.md` formats supported
- [ ] CLI `add-skill --format skillmd` scaffolds SKILL.md format
- [ ] `list-skills` shows format column
- [ ] `talon-setup` skill updated with both format options
- [ ] Background agents still receive full skill prompts (eager mode)
- [ ] Internal MCP server names use `__talond_` prefix; user-defined servers with that prefix are rejected

## Testing

- Unit tests for `SkillLoader`: SKILL.md parsing, frontmatter validation, ambiguity error
- Unit tests for `buildSkillIndex`: correct metadata output format
- Unit tests for native `skill_load` interception in agent-runner (mock SDK events)
- Unit tests for `skill-loader-mcp-server.ts`: tool listing, skill lookup, error on unknown skill
- Unit tests for CLI `add-skill --format skillmd`: file generation, config registration
- Unit tests for `customTools` provider API: `ClaudeCodeProvider` intercepts and handles custom tools
- Unit tests for background agent eager loading: verify full prompts passed through
- Unit tests for `__talond_` prefix validation: reject user-defined MCP servers with reserved prefix
- Integration: existing skill tests continue to pass (backwards compatibility)

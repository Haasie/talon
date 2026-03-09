# talonctl CLI Cleanup Board

> Last updated: 2026-03-09

## Goal

Make `talonctl` the single source of truth for all config mutations. Every command
should be solid (atomic writes, validation, importable functions), so the setup
skill and terminal agent can call the same logic.

---

## ✅ Done

| ID | Title | Commit |
|----|-------|--------|
| CLI-018 | Shared config utilities (`config-utils.ts`) | `cd5d5c0` |
| CLI-001 | `add-channel` refactor (config-utils, type validation, 18 tests) | `574d430` |
| CLI-002 | `add-persona` refactor (config-utils, name validation, 13 tests) | `c269e24` |
| CLI-003 | `add-skill` refactor (config-utils, name validation, 14 tests) | `3d7e518` |
| CLI-004 | `setup` atomic writes for config generation | `8a5b4eb` |
| CLI-005 | `chat` JSON.parse try-catch + --tls flag | `48c9b8b` |
| CLI-006 | `backup` post-VACUUM verification + path validation | `2b4f542` |
| CLI-007 | `queue-purge` status value validation | `b02111c` |

---

## 📋 Tasks — Fix Existing Commands (DONE)

| ID | Command | Description |
|----|---------|-------------|
| CLI-001 | `add-channel` | Atomic writes (`write-file-atomic`). Validate name (`^[a-zA-Z0-9_-]+$`). Validate type against `ChannelConfigSchema` enum. Extract core logic into importable function. Add tests. |
| CLI-002 | `add-persona` | Atomic writes. Name validation. Fix race condition (existsSync + writeFile). Extract importable function. Add tests. |
| CLI-003 | `add-skill` | Atomic writes. Name validation. Already has good tests — extend for edge cases. Extract importable function. |
| CLI-004 | `setup` | Either make it actually interactive (prompts) or rename to `init` and document it as automated bootstrap. Currently misleading. |
| CLI-005 | `chat` | Wrap JSON.parse in try-catch (line 67). Add `--tls` / `wss://` support. |
| CLI-006 | `backup` | Verify backup file exists after VACUUM. Stricter path validation. |
| CLI-007 | `queue-purge` | Validate status values against known enum before sending to daemon. |

---

## 📋 Tasks — New Commands

| ID | Command | Description |
|----|---------|-------------|
| CLI-008 | `list-channels` | Print all channels from config: name, type, enabled. Table format. |
| CLI-009 | `list-personas` | Print all personas from config: name, model, skills count, bound channels. |
| CLI-010 | `list-skills` | Print all skills for a persona (or all personas): name, MCP servers, prompts. |
| CLI-011 | `bind` | Bind persona to channel: `talonctl bind --persona assistant --channel my-telegram`. Creates binding in config. Validates both exist. |
| CLI-012 | `unbind` | Remove persona-channel binding: `talonctl unbind --persona assistant --channel my-telegram`. |
| CLI-013 | `add-mcp` | Add MCP server to a skill: `talonctl add-mcp --skill web-research --name brave-search --transport stdio --command npx --args "-y @modelcontextprotocol/server-brave-search" --env BRAVE_API_KEY=\${BRAVE_API_KEY}`. Creates skill directory structure and MCP JSON config if needed. |
| CLI-014 | `env-check` | Scan config for all `${ENV_VAR}` placeholders. Check each is set in environment. Report missing vars. |
| CLI-015 | `remove-channel` | Remove channel from config by name. Warn about existing bindings. |
| CLI-016 | `remove-persona` | Remove persona from config by name. Warn about existing bindings and skills directory. |
| CLI-017 | `config-show` | Dump effective config (after env var substitution and defaults). Mask secrets. |

---

## 📋 Tasks — Cross-Cutting

| ID | Title | Description |
|----|-------|-------------|
| CLI-018 | ~~Extract shared config utilities~~ | ✅ Done — `src/cli/config-utils.ts` with `readConfig()`, `writeConfigAtomic()`, `validateName()`, `VALID_CHANNEL_TYPES`. |
| CLI-019 | Rewrite setup skill | Replace direct YAML editing with calls to the extracted CLI functions. Same conversational flow, but delegates to `addChannel()`, `addPersona()`, `addSkill()`, `bind()` etc. |
| CLI-020 | Bindings in config | Currently bindings are DB-only (created on daemon startup from config). Add explicit `bindings` section to `talond.yaml` so CLI commands can manage them. Or: keep DB-only but add CLI commands that talk to daemon via IPC. Needs design decision. |

---

## 📝 Notes

- **Atomic writes**: Use `write-file-atomic` (already a dependency for IPC).
- **Name validation**: `^[a-zA-Z0-9_-]+$` — no spaces, dots, or special chars.
- **Importable functions**: Each command should export its core logic as a function (not just a CLI entrypoint) so the setup skill and terminal agent can call it programmatically.
- **Test coverage**: `add-skill` has 12 tests. `add-channel` and `add-persona` have zero. Target: tests for every command.
- **CLI-020 decision**: Bindings are currently created implicitly by daemon startup code (`channel-setup.ts`) — it creates a default binding when a channel has no persona. Explicit binding config would let the CLI manage persona-channel mappings without the daemon running.

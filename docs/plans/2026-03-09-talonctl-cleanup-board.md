# talonctl CLI Cleanup Board

> Last updated: 2026-03-09

## Goal

Make `talonctl` the single source of truth for all config mutations. Every command
should be solid (atomic writes, validation, importable functions), so the setup
skill and terminal agent can call the same logic.

---

## ✅ Done (All 20/20 complete)

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
| CLI-008 | `list-channels` (4 tests) | `1493091` |
| CLI-009 | `list-personas` (3 tests) | `1493091` |
| CLI-010 | `list-skills` (4 tests) | `1493091` |
| CLI-011 | `bind` command + bindings config (10 tests) | `0df544b` |
| CLI-012 | `unbind` command (10 tests, shared with CLI-011) | `0df544b` |
| CLI-013 | `add-mcp` MCP server configs (8 tests) | `910c0cf` |
| CLI-014 | `env-check` audit config env vars (5 tests) | `f5488e1` |
| CLI-015 | `remove-channel` with binding cascade (5 tests) | `27f247f` |
| CLI-016 | `remove-persona` with binding cascade (5 tests) | `27f247f` |
| CLI-017 | `config-show` with secret masking (6 tests) | `158fa94` |
| CLI-019 | Rewrite setup skill to use talonctl commands | `2c9876d` |
| CLI-020 | Bindings in config (`bindings` array in `talond.yaml`) | `0df544b` |

---

## 📝 Notes

- **Atomic writes**: All config mutations use `write-file-atomic`.
- **Name validation**: `^[a-zA-Z0-9_-]+$` for `add-*` and `bind`/`unbind`. Remove commands skip format validation to support legacy names.
- **Importable functions**: Every command exports a pure function (throws on error) + thin CLI wrapper (try/catch → console + exit).
- **Test coverage**: 213 CLI tests across 20 test files. All commands covered.
- **CLI-020 decision**: Bindings stored in `talond.yaml` as config-only. The daemon still auto-binds from config on startup — wiring CLI bindings into runtime routing is a future task.
- **Review**: Reviewed by Codex (gpt-5.3-codex), GitHub Copilot, and GPT-5.4. All findings addressed or documented as by-design.
- **Per-channel setup skills**: Added `add-telegram`, `add-slack`, `add-discord`, `add-whatsapp`, `add-email`, `add-terminal` skills with comprehensive setup guides.

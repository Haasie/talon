# Talon — Outstanding Work

## Critical: In-Container Agent Runner (TASK-035)

The sandbox container (`talon-sandbox:latest`) has no agent entrypoint. The
`SdkProcessSpawner` expects to exec `node /app/node_modules/.bin/claude-code --sdk-mode`
inside the container, but:

1. The sandbox image only installs `@anthropic-ai/sdk`, not `claude-code`
2. There is no entrypoint script that reads JSON config from stdin, invokes
   the Claude API, and emits sentinel-framed output
   (`---TALOND_OUTPUT_START---` / `---TALOND_OUTPUT_END---`)
3. The container runs with `ReadonlyRootfs: true` and `NetworkMode: none`,
   so it cannot install packages or call external APIs

### What needs to happen

- Design and build the in-container agent runner script:
  - Reads `SdkSpawnConfig` JSON from stdin
  - Authenticates with Claude (subscription OAuth or API key)
  - Runs a conversation turn using `@anthropic-ai/sdk` or Claude Agent SDK
  - Handles IPC for tool requests (reads from `/ipc/input`, writes to `/ipc/output`)
  - Emits structured output with sentinel markers, SESSION_ID, TOKEN_USAGE, TOOL_CALL lines
- Update `deploy/Dockerfile.sandbox` to include the entrypoint script
- Configure network access per-persona (at minimum the container needs to reach
  `api.anthropic.com` or `claude.ai`)
- Handle subscription auth (OAuth token forwarding) vs API key auth

### Current workaround

A temporary direct-mode handler in the daemon bypasses container sandboxing
entirely and calls the Claude API from the host process. This is for testing
the end-to-end message flow only. It must be replaced before production use.

---

## Setup Skill Improvements (TASK-036)

The `/talon-setup` Claude Code skill (`.claude/skills/talon-setup/SKILL.md`)
currently edits `talond.yaml` directly, duplicating config structure knowledge.

### What needs to change

- The skill should delegate to `talonctl` CLI commands as the single source of
  truth for config mutations
- CLI commands that may need enhancement:
  - `talonctl add-channel` — accept `--set key=value` for connector-specific fields
  - `talonctl add-persona` — accept `--model`, `--system-prompt`, `--channels` flags
  - `talonctl bind` — new command to create channel→persona bindings
  - `talonctl env-check` — validate that required env vars are set for configured channels
- The skill should only provide conversational guidance and call CLI commands,
  never write YAML directly

### Field name mismatches found during testing

- Telegram: skill used `token` instead of `botToken`, `allowedUserIds` instead
  of `allowedChatIds` (fixed in skill, but highlights the duplication problem)

---

## Bugs Fixed During First Deploy

For reference, these were found and fixed during the first real deployment:

1. **cron-parser ESM import** — CommonJS module needs default import (`5456c61`)
2. **SQL migrations not in dist/** — `tsc` doesn't copy `.sql` files (`8e22e9f`)
3. **No env var substitution in config** — `${ENV_VAR}` was passed as literal string (`fb6a309`)
4. **Channel rows not seeded in DB** — pipeline couldn't find channels (`79e82bd`)
5. **No default channel→persona binding** — messages dropped with `no_persona` (`f382655`)
6. **Relative Docker mount paths** — Docker requires absolute paths for binds (`5828635`)

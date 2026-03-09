---
name: talon.setup
description: |
  Use when setting up Talon for the first time, adding channels or personas to an
  existing config, or running validation. Also use when the user says "configure
  talon", "add a channel", "add a persona", or "set up the daemon".
triggers:
  - "setup talon"
  - "configure talon"
  - "talon setup"
  - "add channel"
  - "add persona"
  - "set up the daemon"
---

# Talon Setup Skill

Guide the user through setting up and configuring Talon interactively. This is a
conversational wizard — ask one question at a time, act on the answer, then move
to the next step.

## Core Principles

- **One question at a time.** Never dump a wall of questions.
- **Detect state first.** Skip steps that are already done.
- **Use talonctl commands.** Never edit talond.yaml directly. Use the CLI commands.
- **No secrets.** Never ask for or write actual tokens. Use `${ENV_VAR}` placeholders only.
- **Show what you do.** When running commands, show the output.

## Available talonctl Commands

All config mutations MUST go through these commands:

| Command | Purpose |
|---------|---------|
| `npx talonctl setup` | Bootstrap (dirs, config, migrations) |
| `npx talonctl add-channel --name <n> --type <t>` | Add a channel |
| `npx talonctl add-persona --name <n>` | Scaffold persona + add to config |
| `npx talonctl add-skill --name <n> --persona <p>` | Add a skill to a persona |
| `npx talonctl bind --persona <p> --channel <c>` | Bind persona to channel |
| `npx talonctl unbind --persona <p> --channel <c>` | Remove binding |
| `npx talonctl add-mcp --skill <s> --name <n> --transport stdio --command <c>` | Add MCP server |
| `npx talonctl list-channels` | Show channels |
| `npx talonctl list-personas` | Show personas |
| `npx talonctl list-skills` | Show skills |
| `npx talonctl env-check` | Audit env var placeholders |
| `npx talonctl config-show` | Show effective config (secrets masked) |
| `npx talonctl remove-channel --name <n>` | Remove a channel |
| `npx talonctl remove-persona --name <n>` | Remove a persona |
| `npx talonctl migrate` | Run database migrations |
| `npx talonctl doctor` | Validate configuration |

## State Detection

Before starting, check the current state:

```
Check these files/directories:
- talond.yaml              → config exists?
- node_modules/            → dependencies installed?
- dist/                    → project built?
- data/                    → data directory exists?
- data/talond.sqlite       → database initialized?
```

### Entry Points

| State | Action |
|-------|--------|
| No `talond.yaml` | Full flow from step 1 |
| Config exists, no channels | Skip to Channel Configuration |
| Config exists, has channels and personas | Show menu |

### Returning User Menu

If setup is already complete, present:

```
What would you like to do?
  a) Add a channel
  b) Add a persona
  c) Add a skill to a persona
  d) Bind/unbind persona to channel
  e) Run validation (doctor)
  f) Show current config summary
  g) Check environment variables
```

## Full Setup Flow

### Step 1: Prerequisites

Check each prerequisite. Report status. Fix what can be fixed automatically.

```
1. Node.js >= 22          → check `node --version`
2. Docker available       → check `docker info`
3. Dependencies installed → check node_modules/, run `npm install` if not
4. Project built          → check dist/, run `npm run build` if not
```

### Step 2: Bootstrap

Skip if `talond.yaml` already exists.

Run: `npx talonctl setup`

This creates directories, generates default config, runs migrations, validates.

### Step 3: Channel Configuration

Ask: **"Which channel do you want to connect first?"**

```
a) Telegram
b) Slack
c) Discord
d) WhatsApp
e) Email
f) Terminal (for CLI chat)
g) Skip for now
```

For each selected channel:

1. Ask for a channel name (suggest defaults like "my-telegram")
2. Run: `npx talonctl add-channel --name <name> --type <type>`
3. Edit the config to set `${ENV_VAR}` placeholders for credentials (use Edit tool on talond.yaml to update the config section)
4. Tell the user which env vars to set (see channel-specific guidance below)

Ask: **"Add another channel?"** Loop until done.

#### Channel-Specific Env Vars

**Telegram:** `TELEGRAM_BOT_TOKEN` — get from @BotFather
**Slack:** `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` — from api.slack.com
**Discord:** `DISCORD_BOT_TOKEN` — from discord.com/developers
**WhatsApp:** `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_VERIFY_TOKEN` — from Meta Business Suite
**Email:** `EMAIL_PASSWORD` — use app-specific password
**Terminal:** `TERMINAL_TOKEN` — any string you choose

### Step 4: Persona Configuration

Ask: **"Let's create a persona. What should this agent be called?"**

1. Accept a name (suggest "assistant")
2. Run: `npx talonctl add-persona --name <name>`
3. Ask these questions one at a time:
   - **"What should {name} do?"** (purpose)
   - **"What tone?"** (professional/casual/technical/friendly)
   - **"Any specific constraints?"** (optional)
4. Generate a system prompt from the answers
5. Show it to the user for review
6. Write the approved prompt to `personas/{name}/system.md` (Edit the file created by add-persona)
7. Ask which channels to bind:
   - Run: `npx talonctl list-channels` to show options
   - For each selected: `npx talonctl bind --persona <name> --channel <channel>`

Ask: **"Add another persona?"** Loop until done.

### Step 5: Database Setup

Run: `npx talonctl migrate --config talond.yaml`

### Step 6: Validation

Run: `npx talonctl doctor --config talond.yaml`

For failures, provide specific remediation steps.

### Step 7: Environment Check

Run: `npx talonctl env-check`

Show which env vars are missing. Tell the user to add them to `.env`.

### Step 8: Systemd Service (Linux only)

Ask: **"Want to install talond as a systemd service?"**

If yes, tell the user to run:
```bash
sudo ./deploy/install-service.sh --user $(whoami) --dir $(pwd)
```

### Step 9: Summary

Run these to build the summary:
```bash
npx talonctl list-channels
npx talonctl list-personas
npx talonctl env-check
```

Print results and instructions to start the daemon.

## Important Rules

1. **Never write actual secrets.** Only `${ENV_VAR}` placeholders in config files.
2. **Use talonctl commands for all config mutations.** The only exception is editing the system prompt file and the channel config section for env var placeholders.
3. **One question per message.** Do not batch questions.
4. **Show command output.** Let the user see what happened.
5. **Don't start the daemon.** Setup only. The user starts it themselves.
6. **Validate at the end.** Always run doctor and env-check before declaring setup complete.

# Setting up Talon

Talon runs on a dedicated VM or server, receives messages from your chat channels, processes them through an AI provider (Claude or Gemini), and sends responses back. This guide gets you from zero to a working deployment.

## What you need

A Linux server with at least 2 cores, 4GB RAM, and a stable internet connection. A small VPS or home server works. Talon uses SQLite, not Postgres, so storage requirements are minimal.

Software:
- Node.js 22+ (Talon uses `process.loadEnvFile`)
- Git
- One or both AI providers installed and authenticated:
  - **Claude Code** (`claude` CLI from Anthropic)
  - **Gemini CLI** (`gemini` from Google)

## Provider setup

Talon talks to AI through CLI providers. You need at least one.

### Claude Code

Install and authenticate:

```bash
npm install -g @anthropic-ai/claude-code
claude auth login
```

Verify it works:

```bash
claude --version
claude --print -p "say hello"
```

Claude uses the Anthropic API. You need a valid API key or a Max subscription with Agent SDK access.

### Gemini CLI

Install and authenticate:

See https://github.com/google-gemini/gemini-cli for the latest install instructions. Then authenticate:

```bash
gemini    # first run triggers OAuth in browser
```

The OAuth flow opens a browser. Complete the Google login once and the tokens get cached in `~/.gemini/oauth_creds.json`. After that, headless runs work without interaction.

Verify:

```bash
gemini --version
gemini --approval-mode yolo --output-format json "say hello"
```

You should get a JSON response with a `response` field and `stats.models` usage data.

If you're running on a headless VM without a browser, do the initial OAuth from a machine with a browser, then copy `~/.gemini/` to the server.

## Installation

```bash
git clone https://github.com/ivo-toby/talon.git
cd talon
npm install
npm run build
```

Run first-time setup:

```bash
npx talonctl setup
```

This creates the `data/` directory, a default `talond.yaml`, and runs database migrations.

## Configuration

The config lives in `talond.yaml`. The setup wizard creates a starter, but you'll want to edit it.

### Providers

This is the part that matters. You configure which AI providers are available and which one is default.

```yaml
agentRunner:
  defaultProvider: claude-code      # or gemini-cli
  providers:
    claude-code:
      enabled: true
      command: claude               # or full path
      contextWindowTokens: 200000
      rotationThreshold: 0.5       # rotate session at 50% context usage
    gemini-cli:
      enabled: true
      command: /home/talon/.npm-global/bin/gemini
      contextWindowTokens: 1000000
      rotationThreshold: 0.8
      options:
        defaultModel: gemini-3.1-pro-preview

backgroundAgent:
  enabled: true
  maxConcurrent: 2
  defaultTimeoutMinutes: 30
  defaultProvider: claude-code
  providers:
    claude-code:
      enabled: true
      command: claude
      contextWindowTokens: 200000
      rotationThreshold: 0.4
    gemini-cli:
      enabled: true
      command: /home/talon/.npm-global/bin/gemini
      contextWindowTokens: 1000000
      rotationThreshold: 0.8
      options:
        defaultModel: gemini-3.1-pro-preview
```

You can run different providers for interactive vs background work. Claude for conversations, Gemini for batch research tasks, or the other way around. Each provider gets its own context window and rotation threshold because they have different limits.

The `command` field needs to resolve on the server. If the binary isn't on PATH, use the full path. Run `which claude` or `which gemini` to find it.

The `options.defaultModel` field is provider-specific. Gemini CLI picks its own model unless you override it here. Claude uses the persona's `model` field from the persona config (that field is ignored by Gemini).

Use `talonctl` to manage providers without editing YAML:

```bash
# see what's configured
npx talonctl list-providers

# add a provider
npx talonctl add-provider --name gemini-cli \
  --command /usr/local/bin/gemini \
  --context both \
  --context-window 1000000 \
  --rotation-threshold 0.8 \
  --enabled \
  --default-model gemini-3.1-pro-preview

# switch the default
npx talonctl set-default-provider --name gemini-cli --context agent-runner

# test it
npx talonctl test-provider --name gemini-cli
```

The test command checks the binary, runs a version check, sends a test prompt, and verifies JSON output parsing. Run it after any provider change.

### Provider affinity

When a thread starts on one provider, it stays on that provider for the rest of the conversation. This prevents mid-conversation switches that would break session continuity (Claude uses session IDs, Gemini doesn't). New threads pick up the current `defaultProvider`.

### Channels

Add channels through the CLI or the Claude Code setup skill (`/talon-setup`):

```bash
npx talonctl add-channel --name my-telegram --type telegram
npx talonctl add-channel --name my-slack --type slack
```

Then edit `talond.yaml` to fill in the credentials. Use `${ENV_VAR}` placeholders and put secrets in `.env`:

```yaml
channels:
  - name: my-telegram
    type: telegram
    enabled: true
    config:
      botToken: ${TELEGRAM_BOT_TOKEN}
      allowedChatIds:
        - "123456789"
      pollIntervalMs: 1000
```

### Personas

A persona is the agent's identity: system prompt, model, tools, and permissions.

```bash
npx talonctl add-persona --name assistant
```

Write the system prompt in `personas/assistant/system.md`. This is where you define the agent's personality, tool access, constraints, and behavior.

Bind the persona to a channel:

```bash
npx talonctl bind --persona assistant --channel my-telegram
```

## Task prompts and schedules

Task prompts are markdown files in `personas/<name>/prompts/` that the agent executes on a schedule. This is where Talon becomes a proactive assistant instead of a reactive chatbot.

### How schedules work

The agent can create its own schedules using the `schedule.manage` capability. You define the prompt file, and either configure a schedule in `talond.yaml` or let the agent schedule it during conversation.

To add a schedule via CLI:

```bash
npx talonctl add-schedule \
  --persona assistant \
  --channel my-telegram \
  --cron "0 7 * * 1-5" \
  --label "Morning briefing" \
  --prompt "Run the morning-briefing task prompt"
```

### Recommended task prompts

These are examples from a production deployment. Adapt them to your setup. Each prompt file lives in `personas/assistant/prompts/`.

#### morning-briefing.md

Runs weekday mornings. Checks calendar, email, Jira, GitHub, and home sensors, then sends a compiled briefing to your channel. The best part: it auto-schedules meeting prep tasks 30 minutes before each meeting.

```
0 7 * * 1-5    Morning briefing
```

#### end-of-day-summary.md

Runs weekday evenings. Recaps what happened, what's still open, and previews tomorrow. Useful for winding down and catching loose threads.

```
0 18 * * 1-5    End of day summary
```

#### weekly-review.md

Friday afternoons. Finds stale Jira tickets, unactioned meeting items, forgotten follow-ups. Cross-references across systems to catch things that slipped through.

```
0 16 * * 5    Weekly review
```

#### week-planning.md

Sunday evenings. Full week overview from both work and personal calendars, grouped by day with focus windows and heavy days flagged. Designed for reviewing with a partner.

```
0 19 * * 0    Week planning
```

#### meeting-prep.md

Not scheduled directly. The morning briefing auto-schedules this 30 minutes before each meeting. It pulls context from Confluence, Jira, email, notes, and memory, then sends a prep brief.

#### grocery-check.md

Sunday evenings. Checks Picnic for delivery slots, reviews past orders from memory, and suggests a cart. Doesn't auto-order.

```
0 18 * * 0    Grocery check
```

### Memory grooming (you need this)

This is the one scheduled task every Talon deployment should have. Without it, the memory store grows without bound and fills with stale, duplicated, or scattered entries.

The memory grooming prompt ships with the default persona at `personas/assistant/prompts/memory-grooming.md`. It tells the agent to list all memory entries, check for stale or duplicate data, consolidate scattered entries, prune what's irrelevant, and report what changed. You don't need to write it, but you do need to schedule it.

```bash
npx talonctl add-schedule \
  --persona assistant \
  --channel my-telegram \
  --cron "0 3 */2 * *" \
  --label "Memory grooming" \
  --prompt "Run the memory-grooming task prompt"
```

Running at 3 AM means it doesn't compete with interactive conversations. The agent uses `memory_access` to read, consolidate, and prune entries, then sends a summary of what it cleaned up.

Every 2-3 days works well. Once a week is the minimum. If you skip this entirely, the agent's memory context gets increasingly noisy and you'll notice degraded recall quality after a few weeks.

## Recommended deployment setup

### Dedicated VM

Run Talon on its own VM or VPS. It doesn't need much (2 cores, 4GB RAM), but it should be always-on and not shared with other workloads that might kill the process.

### Notes in git

Keep work notes, meeting notes, and reference docs in a git-synced folder on the same machine. The agent can read and write to it using the `fs.read` and `fs.write` capabilities, and you get version history for free.

```
/home/talon/notes/
  work/          # work notes, meeting summaries
  personal/      # personal reference material
  rfcs/          # design documents
```

Sync with a private GitHub repo. The agent can commit and push changes when writing notes.

### Systemd service

For production, run Talon as a systemd service:

```ini
[Unit]
Description=Talon Agent Daemon
After=network.target

[Service]
Type=notify
User=talon
WorkingDirectory=/home/talon/talon
ExecStart=/usr/bin/node dist/index.js
Restart=on-failure
RestartSec=10
WatchdogSec=60
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
```

Talon has built-in systemd watchdog support. If the process hangs, systemd will restart it.

### Building after updates

```bash
cd /home/talon/talon
git pull
npm install
npm run build
npx talonctl migrate    # apply any new database migrations
sudo systemctl restart talond
```

Don't rsync or scp the dist/ folder. Always build on the target machine.

## Quick setup with Claude Code

If you have Claude Code installed locally, the fastest path is the interactive setup skill:

```
claude
> /talon-setup
```

This walks you through prerequisites, channel configuration, persona setup, and validation one step at a time. It uses `talonctl` commands under the hood.

## Verifying your setup

```bash
# check system requirements
npx talonctl doctor

# check env vars are set
npx talonctl env-check

# test your providers
npx talonctl test-provider --name claude-code
npx talonctl test-provider --name gemini-cli

# list what's configured
npx talonctl list-providers
npx talonctl list-channels
npx talonctl list-personas

# start the daemon in foreground to watch logs
node dist/index.js
```

When the daemon starts, you should see bootstrap messages for each channel connector, the provider registry, and the context roller. Send a test message from your configured channel and watch the logs for `agent-runner: starting query` with the correct provider name.

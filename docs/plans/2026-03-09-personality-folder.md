# Personality Folder Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Let users enhance a persona's identity with multiple optional markdown files in a `personality/` folder, injected into the system prompt after `systemPromptFile`.

**Architecture:** The persona loader globs `personas/<name>/personality/*.md`, sorts alphabetically, reads each file, and stores them alongside `systemPromptContent`. The agent runner concatenates them after the system prompt and before skill fragments. `talonctl add-persona` scaffolds the folder with an example file. A `create-personality` skill guides users through creating personality files interactively.

**Tech Stack:** Node.js `fs/promises`, `glob` (via fast-glob or manual readdir), Vitest for tests.

---

### Task 1: Add personality content to LoadedPersona type

**Files:**
- Modify: `src/personas/persona-types.ts`

**Step 1: Write the failing test**

No test needed — this is a type-only change.

**Step 2: Add the field**

In `src/personas/persona-types.ts`, add `personalityContent` to `LoadedPersona`:

```typescript
export interface LoadedPersona {
  config: PersonaConfig;
  systemPromptContent?: string;
  personalityContent?: string;  // ← NEW: concatenated personality/*.md files
  resolvedCapabilities: ResolvedCapabilities;
}
```

**Step 3: Commit**

```bash
git add src/personas/persona-types.ts
git commit -m "feat: add personalityContent field to LoadedPersona"
```

---

### Task 2: Load personality files in PersonaLoader

**Files:**
- Modify: `src/personas/persona-loader.ts`
- Test: `tests/unit/personas/persona-loader-personality.test.ts`

**Step 1: Write the failing test**

Create `tests/unit/personas/persona-loader-personality.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PersonaLoader } from '../../../src/personas/persona-loader.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'talon-personality-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function scaffoldPersona(name: string, opts?: { personality?: Record<string, string> }): string {
  const personaDir = join(tmpDir, 'personas', name);
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(join(personaDir, 'system.md'), '# System\nYou are a test agent.');

  if (opts?.personality) {
    const personalityDir = join(personaDir, 'personality');
    mkdirSync(personalityDir, { recursive: true });
    for (const [file, content] of Object.entries(opts.personality)) {
      writeFileSync(join(personalityDir, file), content);
    }
  }

  return `personas/${name}/system.md`;
}

describe('PersonaLoader — personality folder', () => {
  it('loads and concatenates personality files in alphabetical order', async () => {
    const systemPromptFile = scaffoldPersona('alfred', {
      personality: {
        '01-tone.md': '## Tone\nBe formal and precise.',
        '02-background.md': '## Background\nYou are a British butler.',
      },
    });

    const loader = new PersonaLoader(tmpDir);
    const result = await loader.loadPersona({
      name: 'alfred',
      model: 'claude-sonnet-4-6',
      systemPromptFile,
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isOk()).toBe(true);
    const persona = result._unsafeUnwrap();
    expect(persona.personalityContent).toContain('## Tone');
    expect(persona.personalityContent).toContain('## Background');
    // 01-tone should come before 02-background
    const toneIdx = persona.personalityContent!.indexOf('## Tone');
    const bgIdx = persona.personalityContent!.indexOf('## Background');
    expect(toneIdx).toBeLessThan(bgIdx);
  });

  it('returns undefined personalityContent when no personality folder exists', async () => {
    const systemPromptFile = scaffoldPersona('basic');

    const loader = new PersonaLoader(tmpDir);
    const result = await loader.loadPersona({
      name: 'basic',
      model: 'claude-sonnet-4-6',
      systemPromptFile,
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isOk()).toBe(true);
    const persona = result._unsafeUnwrap();
    expect(persona.personalityContent).toBeUndefined();
  });

  it('returns undefined personalityContent when personality folder is empty', async () => {
    const systemPromptFile = scaffoldPersona('empty-personality', { personality: {} });

    const loader = new PersonaLoader(tmpDir);
    const result = await loader.loadPersona({
      name: 'empty-personality',
      model: 'claude-sonnet-4-6',
      systemPromptFile,
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isOk()).toBe(true);
    const persona = result._unsafeUnwrap();
    expect(persona.personalityContent).toBeUndefined();
  });

  it('only reads .md files from personality folder', async () => {
    const systemPromptFile = scaffoldPersona('filtered', {
      personality: {
        'tone.md': '## Tone\nCasual.',
        'notes.txt': 'This should be ignored.',
        'draft.bak': 'This too.',
      },
    });

    const loader = new PersonaLoader(tmpDir);
    const result = await loader.loadPersona({
      name: 'filtered',
      model: 'claude-sonnet-4-6',
      systemPromptFile,
      skills: [],
      capabilities: { allow: [], requireApproval: [] },
    });

    expect(result.isOk()).toBe(true);
    const persona = result._unsafeUnwrap();
    expect(persona.personalityContent).toContain('## Tone');
    expect(persona.personalityContent).not.toContain('ignored');
    expect(persona.personalityContent).not.toContain('This too');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/personas/persona-loader-personality.test.ts`
Expected: FAIL — `personalityContent` is always undefined

**Step 3: Implement personality loading in PersonaLoader**

In `src/personas/persona-loader.ts`, add a `readPersonalityFolder` method and call it from `loadPersona`:

```typescript
import { readdir } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';

// Inside the class, add method:
private async readPersonalityFolder(systemPromptFile: string): Promise<string | undefined> {
  // Personality folder is sibling to systemPromptFile: personas/<name>/personality/
  const personaDir = dirname(resolve(this.baseDir, systemPromptFile));
  const personalityDir = join(personaDir, 'personality');

  let entries: string[];
  try {
    entries = await readdir(personalityDir);
  } catch {
    return undefined; // Folder doesn't exist — that's fine
  }

  const mdFiles = entries
    .filter((f) => f.endsWith('.md'))
    .sort();

  if (mdFiles.length === 0) return undefined;

  const contents: string[] = [];
  for (const file of mdFiles) {
    const content = await readFile(join(personalityDir, file), 'utf-8');
    contents.push(content.trim());
  }

  return contents.join('\n\n');
}
```

Then in `loadPersona()`, after reading the system prompt, call it and store the result:

```typescript
let personalityContent: string | undefined;
if (config.systemPromptFile) {
  personalityContent = await this.readPersonalityFolder(config.systemPromptFile);
}
```

And include it in the returned `LoadedPersona`:

```typescript
return ok({
  config,
  systemPromptContent,
  personalityContent,
  resolvedCapabilities,
});
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/personas/persona-loader-personality.test.ts`
Expected: PASS (all 4 tests)

**Step 5: Commit**

```bash
git add src/personas/persona-loader.ts src/personas/persona-types.ts tests/unit/personas/persona-loader-personality.test.ts
git commit -m "feat: load personality/*.md files from persona directory"
```

---

### Task 3: Inject personality content into agent system prompt

**Files:**
- Modify: `src/daemon/agent-runner.ts`
- Test: `tests/unit/daemon/agent-runner-personality.test.ts`

**Step 1: Write the failing test**

Create a focused test that verifies personality content is included in the system prompt assembly. The exact test depends on how agent-runner is structured — it may need a mock or a direct unit test of the prompt assembly logic. At minimum, verify the ordering:

1. System prompt content
2. Personality content ← NEW
3. Skill prompt fragments
4. Channel context

**Step 2: Modify agent-runner.ts**

In `src/daemon/agent-runner.ts`, find the system prompt assembly (around lines 136-138):

```typescript
// BEFORE:
const systemPrompt = [loadedPersona.systemPromptContent ?? '', skillPrompt, channelContext]
  .filter(Boolean)
  .join('\n\n');

// AFTER:
const systemPrompt = [
  loadedPersona.systemPromptContent ?? '',
  loadedPersona.personalityContent ?? '',
  skillPrompt,
  channelContext,
]
  .filter(Boolean)
  .join('\n\n');
```

**Step 3: Run existing agent-runner tests + new test**

Run: `npx vitest run tests/unit/daemon/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/daemon/agent-runner.ts tests/unit/daemon/
git commit -m "feat: inject personality content into agent system prompt"
```

---

### Task 4: Scaffold personality folder in talonctl add-persona

**Files:**
- Modify: `src/cli/commands/add-persona.ts`
- Modify: `tests/unit/cli/add-persona.test.ts`

**Step 1: Write the failing test**

Add to `tests/unit/cli/add-persona.test.ts`:

```typescript
it('creates a personality directory with example file', async () => {
  const p = writeMinimalConfig();
  await addPersona({ name: 'alfred', configPath: p });

  const personalityDir = join(tmpDir, 'personas', 'alfred', 'personality');
  const example = readFileSync(join(personalityDir, '01-tone.md'), 'utf-8');
  expect(example).toContain('Tone');
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/cli/add-persona.test.ts`
Expected: FAIL — no personality directory created

**Step 3: Add personality folder scaffolding**

In `src/cli/commands/add-persona.ts`, after creating `system.md`, add:

```typescript
// Create personality directory with example file
const personalityDir = join(personaDir, 'personality');
await mkdir(personalityDir, { recursive: true });
await writeFile(
  join(personalityDir, '01-tone.md'),
  buildExamplePersonalityFile(),
);
```

Add the template function:

```typescript
function buildExamplePersonalityFile(): string {
  return `# Tone & Style

<!-- This file is optional. Add as many .md files as you like to this folder. -->
<!-- They are loaded alphabetically and appended to the system prompt. -->
<!-- Delete this file or edit it to match your agent's personality. -->

- Be concise and direct.
- Use a professional but approachable tone.
- Avoid jargon unless the user uses it first.
`;
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/cli/add-persona.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cli/commands/add-persona.ts tests/unit/cli/add-persona.test.ts
git commit -m "feat: scaffold personality folder in add-persona command"
```

---

### Task 5: Create the create-personality skill

**Files:**
- Create: `.claude/skills/create-personality/SKILL.md`

**Step 1: Write the skill**

Create `.claude/skills/create-personality/SKILL.md`:

```markdown
---
name: create-personality
description: |
  Create personality files for a Talon persona. Use when the user says
  "create personality", "add personality", "define personality",
  "persona personality", or "customize persona voice".
triggers:
  - "create personality"
  - "add personality"
  - "define personality"
  - "customize persona"
  - "persona voice"
  - "persona tone"
---

# Create Personality Files

Guide the user through creating personality files for a Talon persona.
Personality files are markdown files in `personas/<name>/personality/` that
get appended to the system prompt (after `system.md`, before skills).

## Phase 1: Select Persona

1. Run `npx talonctl list-personas` to show available personas.
2. Ask the user which persona to create personality files for.
3. Check if `personas/<name>/personality/` exists. If not, create it.

## Phase 2: Gather Personality Traits

Ask the user the following questions (they can skip any):

1. **Tone & voice**: "How should this agent sound? (e.g., formal, casual, witty, dry, warm)"
2. **Background & role**: "What's this agent's backstory or expertise? (e.g., British butler, senior engineer, research librarian)"
3. **Communication style**: "Any formatting preferences? (e.g., uses bullet points, keeps responses short, avoids emoji, uses code blocks)"
4. **Boundaries**: "Anything the agent should avoid? (e.g., no opinions on politics, never uses slang, avoids humor)"
5. **Examples**: "Can you give 1-2 examples of how this agent should respond to a casual question?"

## Phase 3: Generate Files

Based on the answers, create the appropriate files. Use numbered prefixes
for ordering (e.g., `01-tone.md`, `02-background.md`). Only create files
for traits the user provided — don't create empty placeholder files.

### File templates

**`01-tone.md`** — Voice and tone guidelines:
```markdown
# Tone & Voice

[User's tone description, written as directives]
```

**`02-background.md`** — Role and expertise:
```markdown
# Background & Role

[User's backstory, written as context the agent can reference]
```

**`03-style.md`** — Communication and formatting:
```markdown
# Communication Style

[User's formatting and response preferences, as rules]
```

**`04-boundaries.md`** — What to avoid:
```markdown
# Boundaries

[User's avoidance rules, written as constraints]
```

**`05-examples.md`** — Few-shot examples:
```markdown
# Response Examples

These examples illustrate the expected tone and style.

**User:** [example question]
**Agent:** [example response]
```

## Phase 4: Review

1. Show the user all generated files with their content.
2. Ask: "Want to adjust anything, add more files, or are we good?"
3. If adjustments needed, edit the files.

## Phase 5: Validate

1. Run `npx talonctl config-show` to verify the persona config is valid.
2. Remind the user: "Personality files are loaded when the daemon starts.
   Run `npx talonctl reload` or restart the daemon to pick up changes."

## Tips

- Files are loaded **alphabetically** — use numbered prefixes (`01-`, `02-`) to control order.
- Only `.md` files are loaded. Use `.draft.md.bak` or `.txt` for notes that shouldn't be injected.
- Keep files focused — one trait per file makes it easy to enable/disable by renaming.
- The system prompt + personality + skills are concatenated. Keep personality concise to leave room for conversation context.
```

**Step 2: Commit**

```bash
git add .claude/skills/create-personality/SKILL.md
git commit -m "feat: add create-personality skill for guided persona customization"
```

---

### Task 6: Update README

**Files:**
- Modify: `README.md`

**Step 1: Add personality folder to Personas section**

In the Personas section of README.md, after the persona config example, add a brief description:

```markdown
### Personality Files

Each persona can have an optional `personality/` folder containing markdown files
that enhance the agent's identity. Files are loaded alphabetically and appended
to the system prompt after `system.md`.

```
personas/alfred/
  system.md              # Core system prompt (what the agent does)
  personality/
    01-tone.md           # Voice and communication style
    02-background.md     # Role context and expertise
    03-boundaries.md     # What to avoid
```

Create personality files interactively with the `create-personality` skill, or
add `.md` files manually. Only `.md` files are loaded — use other extensions for
drafts or notes.
```

**Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add personality folder to README personas section"
```

---

## Summary

| Task | What | Tests |
|------|------|-------|
| 1 | Add `personalityContent` to `LoadedPersona` type | — |
| 2 | Load `personality/*.md` in PersonaLoader | 4 tests |
| 3 | Inject into system prompt in agent-runner | 1+ tests |
| 4 | Scaffold folder in `talonctl add-persona` | 1 test |
| 5 | Create `create-personality` skill | — |
| 6 | Update README | — |

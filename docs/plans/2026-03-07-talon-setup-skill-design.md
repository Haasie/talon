# Talon Setup Skill Design

**Date:** 2026-03-07
**Status:** Implemented

## Decision Summary

| Question | Decision |
|----------|----------|
| Scope | Full guided setup — detects state, adjusts flow accordingly |
| Secrets handling | Env var placeholders only, never write actual tokens |
| Config manipulation | Direct file editing for config, `talonctl` for migrate/doctor |
| Invocation | `/talon.setup` |
| System prompt authoring | Conversational — ask purpose/tone/constraints, generate, review |

## Flow

1. Detect state (talond.yaml, node_modules, dist, data)
2. Prerequisites (Node 22+, Docker, npm install, npm build)
3. Bootstrap (create data dirs, generate talond.yaml)
4. Channel configuration (iterative, channel-specific guidance)
5. Persona configuration (iterative, conversational system prompt authoring)
6. Database setup (talonctl migrate)
7. Validation (talonctl doctor)
8. Summary (channels, personas, env vars to set, how to start)

## Implementation

Single skill file at `.claude/skills/talon-setup/SKILL.md`.

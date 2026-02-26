# Task TASK-001: Project scaffolding: package.json, tsconfig, ESLint, Prettier, Vitest

## Changes Made

### Configuration files

- `/home/ivo/workspace/newclaw/.worktrees/TASK-001/package.json`
  - ESM project (`"type": "module"`)
  - All runtime and dev dependencies as specified
  - Scripts: build, dev, test, test:watch, test:coverage, lint, format, talond, talonctl, migrate
  - Engine constraint: `"node": ">=22"`
  - Lint script targets `src/**/*.ts` with glob pattern (ESLint 9 errors on empty globs, so tests are added when test files exist)

- `/home/ivo/workspace/newclaw/.worktrees/TASK-001/tsconfig.json`
  - Strict mode, ES2022, Node16 module/resolution
  - Path alias `@talon/*` -> `./src/*`

- `/home/ivo/workspace/newclaw/.worktrees/TASK-001/tsconfig.build.json`
  - Extends base tsconfig, excludes test files

- `/home/ivo/workspace/newclaw/.worktrees/TASK-001/eslint.config.js`
  - Flat config with typescript-eslint recommendedTypeChecked + prettier
  - Enforces `no-floating-promises`, `no-unused-vars`, explicit return types
  - Relaxed rules for CLI entry points and test files

- `/home/ivo/workspace/newclaw/.worktrees/TASK-001/.prettierrc`
  - 2-space indent, single quotes, trailing commas, 100-char print width

- `/home/ivo/workspace/newclaw/.worktrees/TASK-001/vitest.config.ts`
  - 80% coverage thresholds (branches, functions, lines, statements)
  - `passWithNoTests: true` so `npm test` succeeds before first test is written
  - Path alias `@talon` -> `./src`

- `/home/ivo/workspace/newclaw/.worktrees/TASK-001/.gitignore`
  - node_modules, dist, data/, coverage/, *.sqlite*, .env, OS/editor artifacts

### Source skeleton

- `src/index.ts` — talond entry point (`console.log('talond starting...')`)
- `src/cli/index.ts` — talonctl entry point (`console.log('talonctl')`)
- Barrel `index.ts` files (with module-level JSDoc) in every directory:
  - `src/core/{config,database,database/migrations,database/repositories,logging,errors,types}/`
  - `src/{ipc,sandbox,tools,tools/host-tools,personas,memory}/`
  - `src/channels/{format,connectors/telegram,connectors/whatsapp,connectors/slack,connectors/email,connectors/discord}/`
  - `src/{queue,scheduler,collaboration,mcp,skills,daemon}/`
- `tests/{unit,integration/e2e}/` directories created (empty — populated by later tasks)

### Config

- `config/talond.example.yaml` — fully documented example covering daemon, claude, sandbox,
  queue, personas, channels (Telegram + commented Slack/Discord/Email), scheduler, MCP,
  and observability sections.

## Tests Added

No test files added in this task (scaffolding only). The vitest config is set to
`passWithNoTests: true` so `npm test` exits 0. Coverage thresholds will be enforced
once source modules have real implementation.

## Deviations from Plan

- `lint` script targets `src/**/*.ts` only (not `tests` as well) because ESLint 9 exits with
  an error when a glob pattern yields zero matches, and the tests directory is empty at this
  stage. The format script still lists both patterns since Prettier handles empty globs
  gracefully. When test files are added, the lint script can be updated to include
  `"tests/**/*.ts"`.

## Status

completed

## Notes

- All four verification commands pass:
  - `npm install` — 334 packages, no install errors
  - `npm run build` — zero TypeScript errors
  - `npm test` — exits 0 (passWithNoTests)
  - `npm run lint` — zero lint errors
- The `migrate` script references `dist/core/database/migrations/run.js` which does not exist
  yet — it will be implemented in TASK-003 (database migrations task).
- ESLint version resolved to 9.39.3 (newer than the `^9.9.0` range specified); all config
  compatible.

#!/usr/bin/env node
/**
 * talonctl bin entrypoint.
 *
 * Delegates to the compiled CLI entry point. Run `npm run build` first,
 * or use `npm run talonctl` which invokes the compiled version.
 *
 * For development: use `npx tsx src/cli/index.ts` instead.
 */
import('../dist/cli/index.js');

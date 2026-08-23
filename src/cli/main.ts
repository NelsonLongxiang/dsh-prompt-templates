#!/usr/bin/env node
/** Package-bin entrypoint. Keep this wrapper unconditional: npm/pnpm may
 * launch it through a symlink or platform shim whose argv[1] differs from the
 * real module path. The reusable/testable command logic lives in app.ts. */
import { run } from './app.ts'

process.exitCode = await run(process.argv.slice(2))

#!/usr/bin/env node
/**
 * The `znight` binary. Everything lives in `main()`; this file only wires the process: arguments,
 * exit code, and a safety net for handles left open by third-party code (prompts, watchers).
 */
import { main } from './main.ts'

const code = await main(process.argv.slice(2))
process.exitCode = code
// let pending output flush, then exit even if a library left a handle open
setTimeout(() => process.exit(code), 1000).unref()

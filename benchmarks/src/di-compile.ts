/**
 * Generates the container of a project and prints the time `generate()` took, in milliseconds:
 * `node src/di-compile.ts <project>`. Run in a fresh process for each sample, like a build.
 */
import { formatDiagnostics, generate } from '@znight/compiler'

const root = process.argv[2]
if (root === undefined) throw new Error('Usage: node src/di-compile.ts <project>')

const started = performance.now()
const result = await generate({ root, mode: 'build' })
const generateMs = performance.now() - started

const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
if (errors.length > 0) throw new Error(formatDiagnostics(errors, { cwd: root }))
process.stdout.write(`${JSON.stringify({ generateMs })}\n`)

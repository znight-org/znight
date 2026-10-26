import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Config } from '@znight/config'

/** Report settings: REPORTS_OUTPUT_DIR, REPORTS_MS_PER_DAY. */
@Config('reports')
export class ReportsConfig {
  /** Directory of the generated files (an initializer can be any expression; the type is then explicit). */
  outputDir: string = join(tmpdir(), 'znight-worker', 'reports')

  /** Simulated cost of one day of data, in milliseconds: a yearly report takes ~2 s by default. */
  msPerDay = 5
}

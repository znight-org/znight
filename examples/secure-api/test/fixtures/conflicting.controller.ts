import { Controller, Get } from '@znight/http'

import { Public, Roles } from '../../src/auth/access.js'

/**
 * Never part of the application: `build-check.test.ts` compiles it next to `src/`. The decorators of
 * a group are alternatives: two decisions on the same target are ZNIGHT005.
 */
@Controller('/reports')
export class ReportController {
  @Get()
  @Public()
  @Roles(['admin'])
  list(): string[] {
    return []
  }
}

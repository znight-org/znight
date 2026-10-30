import { Controller, Delete, Get } from '@znight/http'

import { Authenticated } from '../../src/auth/access.js'

/**
 * Never part of the application: `build-check.test.ts` compiles it next to `src/` to show what a
 * forgotten decision does. `remove` has no decision of the "access" group, neither on itself nor on
 * its controller: ZNIGHT023, the build fails.
 */
@Controller('/drafts')
export class DraftController {
  @Get()
  @Authenticated()
  list(): string[] {
    return []
  }

  @Delete()
  remove(): void {}
}

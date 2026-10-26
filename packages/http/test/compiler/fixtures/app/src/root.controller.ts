// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { ServerResponse } from 'node:http'

import { Controller, Get, Req, Res } from '@znight/http'

@Controller()
export class RootController {
  @Get()
  index() {
    return 'hello'
  }

  @Get('/raw')
  raw(@Req() request: { method?: string }, @Res() response: ServerResponse) {
    response.setHeader('content-type', 'text/plain')
    response.end(`raw ${request.method}`)
  }
}

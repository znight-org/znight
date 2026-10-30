import type { CanActivate, HttpContext } from '@znight/http'
import type { WebhookConfig } from '../config/webhook.config.js'

import { createHmac, timingSafeEqual } from 'node:crypto'
import { Injectable } from '@znight/core'
import { UnauthorizedException } from '@znight/http'

const TOLERANCE_SECONDS = 300

/** `x-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<raw body>">` */
@Injectable()
export class WebhookSignatureGuard implements CanActivate {
  constructor(private readonly config: WebhookConfig) {}

  async canActivate(ctx: HttpContext): Promise<boolean> {
    const fields = new Map<string, string>()
    for (const part of (ctx.header('x-signature') ?? '').split(',')) {
      const separator = part.indexOf('=')
      if (separator > 0) fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim())
    }
    const timestamp = Number(fields.get('t'))
    const signature = Buffer.from(fields.get('v1') ?? '', 'hex')
    if (!Number.isSafeInteger(timestamp) || signature.length === 0) throw new UnauthorizedException('Missing signature')
    if (Math.abs(Date.now() / 1000 - timestamp) > TOLERANCE_SECONDS) throw new UnauthorizedException('Stale signature')

    const body = await ctx.rawBody() // the exact bytes; @Body() parses them afterwards
    const expected = createHmac('sha256', this.config.secret).update(`${timestamp}.`).update(body).digest()
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected)) {
      throw new UnauthorizedException('Invalid signature')
    }
    return true
  }
}

// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { HttpContext } from '@znight/http'

import { Body, Controller, Cookie, Ctx, Get, HttpResponse, Post, SignedCookie } from '@znight/http'
import { z } from 'zod'

export const ThemeInput = z.object({ theme: z.enum(['light', 'dark']) })
// a stale or forged value falls back instead of answering 400 forever (cookies outlive deployments)
export const ThemeCookie = z.enum(['light', 'dark']).catch('light')

@Controller('/prefs')
export class PrefsController {
  @Get()
  read(@Cookie('theme', ThemeCookie) theme: 'light' | 'dark', @Cookie('visits') visits = 0) {
    return { theme, visits }
  }

  @Post('/theme')
  setTheme(@Body(ThemeInput) input: z.output<typeof ThemeInput>, @Ctx() ctx: HttpContext) {
    ctx.setCookie('theme', input.theme, { maxAge: 365 * 86_400, httpOnly: false })
    return HttpResponse.noContent()
  }

  @Post('/login')
  login() {
    return HttpResponse.ok({ id: 'u-1' }).withCookie('__Host-uid', 'u-1', { signed: true, maxAge: 8 * 3600 })
  }

  @Get('/me')
  me(@SignedCookie('__Host-uid') uid: string) {
    return { uid }
  }
}

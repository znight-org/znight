import type { HttpContext } from '../src/index.ts'

import { Injectable } from '@znight/core'
import { z } from 'zod'

import {
  All,
  Body,
  Controller,
  Ctx,
  createRouteDecorator,
  Delete,
  Get,
  Head,
  Header,
  Headers,
  HttpCode,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuard,
  UseInterceptor,
  Validate,
} from '../src/index.ts'
import { describe, expect, it } from 'bun:test'

const Roles = createRouteDecorator<readonly string[]>('roles')
const Public = createRouteDecorator('public')
const Limit = createRouteDecorator<number | undefined>('limit')

const CreateUser = z.object({ name: z.string() })

@Injectable()
class AuthGuard {
  canActivate(): boolean {
    return true
  }
}

@Injectable()
class LogInterceptor {
  intercept(_ctx: HttpContext, next: () => Promise<unknown>): Promise<unknown> {
    return next()
  }
}

@Controller('/users')
@UseGuard(AuthGuard)
@UseInterceptor(LogInterceptor)
@Roles(['admin'])
class UserController {
  @Get('/:id')
  @Public()
  get(@Param('id') id: number, @Query('expand') expand?: string) {
    return { id, expand }
  }

  @Post()
  @HttpCode(202)
  @Header('cache-control', 'no-store')
  @Validate(CreateUser)
  @Limit()
  create(@Body() input: z.output<typeof CreateUser>, @Headers('x-trace') trace?: string) {
    return { input, trace }
  }

  @Put('/:id')
  @UseGuard(AuthGuard, AuthGuard)
  put(@Param() params: Record<string, string>, @Query(CreateUser) query: unknown, @Body(CreateUser) body: unknown) {
    return { params, query, body }
  }

  @Patch(':id')
  patch(@Param('id', z.coerce.number()) id: number, @Query() query: unknown, @Headers() headers: unknown) {
    return { id, query, headers }
  }

  @Delete()
  @Head()
  @Options()
  @All('/any')
  raw(@Req() req: unknown, @Res() res: unknown, @Ctx() ctx: HttpContext) {
    return [req, res, ctx]
  }
}

@Controller({ path: '/scoped', scope: 'request' })
class ScopedController {}

@Controller()
class RootController {}

describe('decorators', () => {
  it('are runtime no-ops that keep classes intact', () => {
    const controller = new UserController()
    expect(controller.get(1, 'x')).toEqual({ id: 1, expand: 'x' })
    expect(Object.getOwnPropertyNames(UserController.prototype).sort()).toEqual([
      'constructor',
      'create',
      'get',
      'patch',
      'put',
      'raw',
    ])
    expect(new ScopedController()).toBeInstanceOf(ScopedController)
    expect(new RootController()).toBeInstanceOf(RootController)
  })

  it('return shared markers returning undefined', () => {
    expect(Get()).toBe(Post('/x'))
    expect(Param()).toBe(Body())
    expect(Controller()).toBe(Controller('/x'))
    expect((Get() as (...args: unknown[]) => unknown)({}, 'x', {})).toBeUndefined()
  })
})

describe('createRouteDecorator', () => {
  it('exposes its key and reads route metadata', () => {
    expect(Roles.key).toBe('roles')
    expect(Public.key).toBe('public')
    const ctx = { route: { meta: { roles: ['admin'], public: true } } } as unknown as HttpContext
    expect(Roles.get(ctx)).toEqual(['admin'])
    expect(Public.get(ctx)).toBe(true)
    expect(Limit.get(ctx)).toBeUndefined()
    expect(Roles.get({ route: undefined } as unknown as HttpContext)).toBeUndefined()
  })

  it('returns no-op markers', () => {
    expect(Roles(['a'])).toBe(Public())
    expect(Limit(3)).toBe(Limit())
  })
})

// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import type { HttpContext } from '@znight/http'

import {
  All,
  Body,
  Controller,
  Ctx,
  Delete,
  Get,
  Head,
  Header,
  Headers,
  HttpCode,
  NotFoundException,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuard,
  UseInterceptor,
  Validate,
} from '@znight/http'

import { AuthGuard } from '../auth/auth.guard.ts'
import { Public, Roles } from '../auth/roles.ts'
import { TimingInterceptor } from '../common/timing.interceptor.ts'
import { CreateUser, IdParam, Ping, SearchQuery, UpdateUser } from './user.schemas.ts'
import { UserService } from './user.service.ts'

export type Sort = 'asc' | 'desc'
export type UserId = string & { readonly __brand: 'UserId' }
export enum Color {
  Red = 'red',
  Blue = 'blue',
}

const BASE = '/users'

@Controller(BASE)
@UseGuard(AuthGuard)
@Roles(['admin'])
export class UserController {
  constructor(private readonly users: UserService) {}

  @Get()
  @Public()
  list(@Query('page') page = 1, @Query('tag') tags: string[] = [], @Query('sort') sort?: Sort) {
    return { page, tags, sort: sort ?? null, count: this.users.list().length }
  }

  @Get('/search')
  @Public()
  search(@Query(SearchQuery) query: { q: string; limit: number }) {
    return query
  }

  @Get('/:id')
  @Roles(['admin', 'reader'])
  @UseInterceptor(TimingInterceptor)
  find(@Param('id') id: number) {
    const user = this.users.find(id)
    if (user === undefined) throw new NotFoundException(`User ${id} not found`)
    return user
  }

  @Post()
  create(@Body(CreateUser) input: CreateUser) {
    return this.users.create(input)
  }

  @Put('/:id')
  @Validate(UpdateUser)
  update(@Param('id', IdParam) id: number, @Body() input: { name: string }) {
    return { id, ...input }
  }

  @Delete('/:id')
  @HttpCode(202)
  @Header('X-Deleted', 'yes')
  remove(@Param('id') id: number) {
    return { deleted: this.users.remove(id) }
  }

  @Patch('/:id/flags')
  flags(
    @Param() params: Record<string, string>,
    @Headers('X-Flag') flag: boolean,
    @Headers() headers: Record<string, string | undefined>,
  ) {
    return { params, flag, agent: headers['user-agent'] ?? null }
  }

  @Head('/:id')
  exists(@Param('id') id: number) {
    if (this.users.find(id) === undefined) throw new NotFoundException()
  }

  @Options()
  @Public()
  options(@Ctx() ctx: HttpContext) {
    ctx.setHeader('allow', 'GET, POST')
  }

  @All('/legacy/*')
  @Public()
  legacy(@Param('*') rest: string, @Ctx() ctx: HttpContext) {
    return { method: ctx.method, rest }
  }

  @Post('/ping')
  @Public()
  @Validate(Ping)
  ping() {
    return 'pong'
  }

  @Get('/typed/:day')
  @Public()
  typed(
    @Param('day') day: Date,
    @Query('flag') flag: boolean | undefined,
    @Query('big') big?: bigint,
    @Query('ids') ids?: UserId[],
    @Query('color') color?: Color,
    @Headers('x-id') xid?: UserId,
  ) {
    return {
      day: day.toISOString(),
      flag: flag ?? null,
      big: big === undefined ? null : `${big}`,
      ids: ids ?? [],
      color: color ?? null,
      xid: xid ?? null,
    }
  }
}

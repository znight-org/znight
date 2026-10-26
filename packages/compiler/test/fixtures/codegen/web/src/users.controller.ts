import { Controller, Get, Guard } from '@fixture/web'
import { AdminGuard } from './guards.js'
import { UserSchema } from './schemas.js'

const BASE = '/users'

@Controller(BASE)
@Guard(AdminGuard)
export class UsersController {
  @Get('/:id', UserSchema)
  find(id: number): string {
    return `user ${id}`
  }

  @Get('/count')
  count(): number {
    return 2
  }
}

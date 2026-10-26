import { Controller, Get, Param, UseGuard } from '@znight/fake-http'
import { UserService } from '../users/user.service.ts'
import { AuthGuard } from './auth.guard.ts'

@Controller('/users')
@UseGuard(AuthGuard)
export class UserController {
  constructor(readonly users: UserService) {}

  @Get('/:id')
  get(@Param('id') id: string): unknown {
    return this.users.findById(id)
  }
}

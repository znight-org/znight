import { Application } from '@znight/core'
import { metadata } from './.znight/container.generated.ts'
import { UserController } from './http/user.controller.ts'

const app = await Application.create({ metadata })
app.container.get(UserController)

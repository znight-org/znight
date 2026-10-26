import { Application } from '@znight/core'
import { __ZNIGHT_METADATA__ } from './.znight/container.generated.ts'
import { UserController } from './http/user.controller.ts'

const app = await Application.create({ metadata: __ZNIGHT_METADATA__ })
app.container.get(UserController)

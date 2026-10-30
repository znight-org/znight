import { createRouteDecorator } from '@znight/http'

export const Public = createRouteDecorator<boolean>('public')
export const Roles = createRouteDecorator<readonly string[]>('roles')

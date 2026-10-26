// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import { createRouteDecorator } from '@znight/http'

export const Roles = createRouteDecorator<readonly string[]>('roles')
export const Public = createRouteDecorator('public')

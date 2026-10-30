import { HttpPlugin } from '@znight/http'
import { OpenApiPlugin } from '@znight/openapi'

export const plugins = [HttpPlugin.configure({ port: 0 }), OpenApiPlugin.configure()]

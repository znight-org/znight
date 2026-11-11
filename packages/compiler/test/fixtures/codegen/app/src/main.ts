import type { ZnightMetadata } from '@znight/core'
import { createApplication, metadata as generated } from './.znight/container.generated.js'

export const metadata: ZnightMetadata = generated
export const create: typeof createApplication = createApplication

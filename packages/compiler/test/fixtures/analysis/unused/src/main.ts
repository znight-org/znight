import type { Container } from '@znight/core'
import * as services from './services.ts'
import { Port } from './services.ts'

export function boot(container: Container): void {
  container.get(services.ReferencedInMain)
  container.get(Port)
}

import type { PipeTransform } from '@nestjs/common'
import type { z } from 'zod'

import { BadRequestException } from '@nestjs/common'

/** Validates an argument with a Zod schema: the GraphQL counterpart of the HTTP benchmark's body pipe. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value)
    if (!result.success) throw new BadRequestException({ message: 'Invalid input', issues: result.error.issues })
    return result.data
  }
}

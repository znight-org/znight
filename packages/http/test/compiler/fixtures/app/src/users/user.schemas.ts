// @ts-nocheck — fixture application, analysed by the compiler tests from a temporary copy
import * as v from 'valibot'
import { z } from 'zod'

export const CreateUser = z.object({ name: z.string().min(1), email: z.email() })
export type CreateUser = z.output<typeof CreateUser>

export const UpdateUser = v.object({ name: v.pipe(v.string(), v.minLength(1)) })

export const SearchQuery = z.object({ q: z.string(), limit: z.coerce.number().int().max(100).default(10) })

export const IdParam = z.coerce.number().int().positive()

export const Ping = z.object({ ping: z.literal(true) })

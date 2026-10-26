import { EventEmitter } from 'node:events'
import fs from 'fs'
import cjs from 'cjs-only'
import pg, { Pool } from 'pg'
import { UserService as Aliased } from '@app/users/user.service.ts'
import type { User } from '@app/users/index.ts'
import { formatName } from '#shared/format.ts'
import { DefaultUserRepository, models, UserService } from './users/index.ts'

export const refs = [DefaultUserRepository, UserService, Aliased, pg.Pool, Pool, cjs.Thing, EventEmitter, fs, formatName]
export type MainUser = User | models.User

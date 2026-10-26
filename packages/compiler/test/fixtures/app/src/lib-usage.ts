import DefaultClient, {
  Client,
  DEFAULT_PORT,
  EmailSender,
  Logger,
  type LoggerOptions,
  PREFIX,
  Pool,
  type Repository,
  ROLES,
  tokens,
  type UserRepository,
  V1Client,
} from '@fixture/lib'
import * as lib from '@fixture/lib'
import { OnlyInSub, SubPool } from '@fixture/lib/sub'
import { MailService } from '@fixture/manifest-lib'

export const values = [DefaultClient, Client, EmailSender, Logger, Pool, V1Client, OnlyInSub, SubPool, MailService, lib]
export const PORT = DEFAULT_PORT
export const FIRST_ROLE = ROLES[0]
export const API = PREFIX
export const TOKEN = tokens.TOKEN_A
export type Repo = Repository<Client>
export type UserRepo = UserRepository
export type Options = LoggerOptions

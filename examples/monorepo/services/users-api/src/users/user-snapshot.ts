import type { Logger } from '@znight/observability'
import type { ApiConfig } from '../api.config.js'

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Injectable, type OnStart, type OnStop } from '@znight/core'
import { User, type UserDirectory } from '@znight-examples/shared'

/**
 * Poor man's persistence for the example: restores the users from `USERS_SNAPSHOT_FILE` at startup
 * and saves them on shutdown. Lifecycle hooks are duck-typed: implementing `onStart` / `onStop` is
 * enough, nothing is registered.
 *
 * - `onStart` runs before the HTTP server listens (providers start before plugins);
 * - `onStop` runs after the HTTP server drained its in-flight requests (plugins stop first), so the
 *   snapshot contains every acknowledged write.
 */
@Injectable()
export class UserSnapshot implements OnStart, OnStop {
  constructor(
    private readonly config: ApiConfig,
    private readonly directory: UserDirectory,
    private readonly logger: Logger,
  ) {}

  async onStart(): Promise<void> {
    const file = this.config.snapshotFile
    if (file === undefined) return
    let content: string
    try {
      content = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.logger.info('No users snapshot yet', { file })
      return
    }
    const users = parseSnapshot(content, file)
    for (const user of users) this.directory.upsert(user)
    this.logger.info('Users restored from snapshot', { file, count: users.length })
  }

  async onStop(): Promise<void> {
    const file = this.config.snapshotFile
    if (file === undefined) return
    const users = this.directory.all()
    await mkdir(dirname(file), { recursive: true })
    // write then rename: a crash never leaves a truncated snapshot behind
    await writeFile(`${file}.tmp`, `${JSON.stringify(users, null, 2)}\n`)
    await rename(`${file}.tmp`, file)
    this.logger.info('Users snapshot saved', { file, count: users.length })
  }
}

/** Parses a snapshot, validating every record with the shared `User` schema. */
function parseSnapshot(content: string, file: string): User[] {
  const records: unknown = JSON.parse(content)
  if (!Array.isArray(records)) throw new Error(`Invalid users snapshot ${file}: expected an array`)
  return records.map((record, index) => {
    const result = User['~standard'].validate(record)
    if (result.issues !== undefined) {
      const problems = result.issues.map(issue => `${issue.path?.join('.') ?? ''}: ${issue.message}`).join(', ')
      throw new Error(`Invalid users snapshot ${file}: record ${index}: ${problems}`)
    }
    return result.value
  })
}

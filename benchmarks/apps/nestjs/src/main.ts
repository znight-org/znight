import 'reflect-metadata'

import type { INestApplication } from '@nestjs/common'

import { NestFactory } from '@nestjs/core'

import { AppModule } from './app.module.js'

/** The platform named by `PLATFORM`: the same modules are served by each of them. */
async function create(platform = 'express'): Promise<INestApplication> {
  switch (platform) {
    case 'express': {
      const { ExpressAdapter } = await import('@nestjs/platform-express')
      return NestFactory.create(AppModule, new ExpressAdapter(), { logger: false })
    }
    case 'fastify': {
      const { FastifyAdapter } = await import('@nestjs/platform-fastify')
      return NestFactory.create(AppModule, new FastifyAdapter(), { logger: false })
    }
    default:
      throw new Error(`Unknown platform '${platform}'`)
  }
}

const app = await create(process.env['PLATFORM'])
app.enableShutdownHooks()
await app.listen(Number(process.env['PORT'] ?? 3000), '127.0.0.1')

/**
 * Generated projects of the dependency injection benchmark: N provider classes, one module each,
 * in layers; every provider of a layer depends on three providers of the layer below. Each
 * framework gets the same classes with its own decorator, and a `main.ts` that times the imports,
 * then the creation of the container and of every provider.
 */
import type { DiFramework } from './results.ts'

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const LAYERS = 10
export const DEPENDENCIES = 3

const name = (index: number): string => `Service${String(index).padStart(4, '0')}`
const file = (index: number): string => `service-${String(index).padStart(4, '0')}`

/** Dependencies of each provider, by index: three providers of the layer below. */
export function graph(size: number): number[][] {
  const width = size / LAYERS
  if (!Number.isInteger(width) || width < DEPENDENCIES) throw new Error(`Unsupported size ${size}`)
  return Array.from({ length: size }, (_, index) => {
    const layer = Math.floor(index / width)
    if (layer === 0) return []
    const position = index % width
    return Array.from({ length: DEPENDENCIES }, (_, d) => (layer - 1) * width + ((position + d) % width))
  })
}

const DECORATOR: Readonly<Record<DiFramework, readonly [specifier: string, name: string]>> = {
  znight: ['@znight/core', 'Injectable'],
  nestjs: ['@nestjs/common', 'Injectable'],
  tsyringe: ['tsyringe', 'injectable'],
  inversify: ['inversify', 'injectable'],
}

function providerModule(framework: DiFramework, index: number, dependencies: readonly number[]): string {
  const [specifier, decorator] = DECORATOR[framework]
  const lines = [`import { ${decorator} } from '${specifier}'`, '', "import { counter } from '../counter.js'"]
  for (const dependency of dependencies) lines.push(`import { ${name(dependency)} } from './${file(dependency)}.js'`)
  const parameters = dependencies.map(d => `readonly s${d}: ${name(d)}`).join(', ')
  lines.push('', `@${decorator}()`, `export class ${name(index)} {`)
  lines.push(`  constructor(${parameters}) {`, '    counter.created++', '  }', '}', '')
  return lines.join('\n')
}

/** The entry of each framework: imports timed, then the container and every provider. */
function main(framework: DiFramework): string {
  const report = [
    'const finished = performance.now()',
    'const result = { importMs: imported - started, containerMs: finished - imported, created: counter.created }',
    'process.stdout.write(`${JSON.stringify(result)}\\n`, () => process.exit(0))',
    '',
  ]
  switch (framework) {
    case 'znight':
      return [
        'const started = performance.now()',
        "const { Application } = await import('@znight/core')",
        "const { __ZNIGHT_METADATA__ } = await import('./.znight/container.generated.js')",
        "const { counter } = await import('./counter.js')",
        'const imported = performance.now()',
        // Every singleton is created by Application.create(), in the order computed at build time
        'await Application.create({ metadata: __ZNIGHT_METADATA__ })',
        ...report,
      ].join('\n')
    case 'nestjs':
      return [
        'const started = performance.now()',
        "await import('reflect-metadata')",
        "const { NestFactory } = await import('@nestjs/core')",
        "const { AppModule } = await import('./app.module.js')",
        "const { counter } = await import('./counter.js')",
        'const imported = performance.now()',
        // Every provider of the module is created by createApplicationContext()
        'await NestFactory.createApplicationContext(AppModule, { logger: false })',
        ...report,
      ].join('\n')
    case 'tsyringe':
      return [
        'const started = performance.now()',
        "await import('reflect-metadata')",
        "const { container } = await import('tsyringe')",
        "const { services } = await import('./services.js')",
        "const { counter } = await import('./counter.js')",
        'const imported = performance.now()',
        'for (const service of services) container.registerSingleton(service)',
        'for (const service of services) container.resolve(service)',
        ...report,
      ].join('\n')
    case 'inversify':
      return [
        'const started = performance.now()',
        "await import('reflect-metadata')",
        "const { Container } = await import('inversify')",
        "const { services } = await import('./services.js')",
        "const { counter } = await import('./counter.js')",
        'const imported = performance.now()',
        'const container = new Container()',
        'for (const service of services) container.bind(service).toSelf().inSingletonScope()',
        'for (const service of services) container.get(service)',
        ...report,
      ].join('\n')
  }
}

/** Every provider class, imported by one module (NestJS: the module; tsyringe, InversifyJS: a list). */
function registry(framework: DiFramework, size: number): [path: string, content: string] | undefined {
  if (framework === 'znight') return undefined
  const imports = Array.from({ length: size }, (_, i) => `import { ${name(i)} } from './services/${file(i)}.js'`)
  const list = Array.from({ length: size }, (_, i) => `  ${name(i)},`)
  if (framework === 'nestjs') {
    const lines = ["import { Module } from '@nestjs/common'", '', ...imports, '', '@Module({ providers: [']
    return ['app.module.ts', [...lines, ...list, '] })', 'export class AppModule {}', ''].join('\n')]
  }
  return ['services.ts', [...imports, '', 'export const services = [', ...list, ']', ''].join('\n')]
}

function tsconfig(framework: DiFramework): string {
  const compilerOptions = {
    target: 'ES2024',
    lib: ['ES2024'],
    module: 'nodenext',
    moduleResolution: 'nodenext',
    types: ['node'],
    strict: true,
    experimentalDecorators: true,
    // Runtime containers read the constructor parameter types from the decorator metadata
    emitDecoratorMetadata: framework !== 'znight',
    skipLibCheck: true,
    rootDir: 'src',
    outDir: 'dist',
  }
  return `${JSON.stringify({ compilerOptions, include: ['src'] }, null, 2)}\n`
}

/** Writes the sources of a project (`dir` is emptied first). */
export function writeProject(dir: string, framework: DiFramework, size: number): void {
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(join(dir, 'src/services'), { recursive: true })
  const write = (path: string, content: string): void => writeFileSync(join(dir, path), content)
  write('package.json', `${JSON.stringify({ name: `di-${framework}-${size}`, private: true, type: 'module' })}\n`)
  write('tsconfig.json', tsconfig(framework))
  write('src/counter.ts', 'export const counter = { created: 0 }\n')
  graph(size).forEach((dependencies, index) => {
    write(`src/services/${file(index)}.ts`, providerModule(framework, index, dependencies))
  })
  const extra = registry(framework, size)
  if (extra !== undefined) write(`src/${extra[0]}`, extra[1])
  write('src/main.ts', main(framework))
}

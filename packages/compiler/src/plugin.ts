import type { Plugin } from 'vite'

import { writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { Project } from 'ts-morph'

import { InjectableAnalyzer } from './analyzer/index.js'
import { ContainerGenerator } from './generator/index.js'
import { formatErrors } from './utils/index.js'
import { DependencyValidator } from './validators/index.js'

export interface ZnightPluginOptions {
  /**
   * Root directory of the project (defaults to process.cwd())
   */
  root?: string

  /**
   * Output path for the generated container file
   * Relative to root directory
   * @default '.znight/container.generated.ts'
   */
  outputPath?: string

  /**
   * tsconfig.json path
   * @default 'tsconfig.json'
   */
  tsconfig?: string
}

/**
 * Znight compiler plugin for Vite
 */
export function znightPlugin(options: ZnightPluginOptions = {}): Plugin {
  const root = options.root || process.cwd()
  const outputPath = options.outputPath || '.znight/container.generated.ts'
  const tsconfigPath = options.tsconfig || 'tsconfig.json'

  let project: Project

  return {
    name: 'znight:compiler',

    async buildStart() {
      console.log('\n🌙 Znight compiler starting...\n')

      // Initialize ts-morph project
      project = new Project({
        tsConfigFilePath: join(root, tsconfigPath),
        skipAddingFilesFromTsConfig: false,
      })

      // Analyze source files
      console.log('📝 Analyzing source files...')
      const analyzer = new InjectableAnalyzer(project)
      const providers = analyzer.analyze()

      console.log(`   Found ${providers.size} providers`)

      // Validate dependencies
      console.log('🔍 Validating dependencies...')
      const validator = new DependencyValidator(providers)
      const validationErrors = validator.validate()

      // Check for duplicates
      const duplicateErrors = DependencyValidator.checkDuplicates(providers)
      const allErrors = [...validationErrors, ...duplicateErrors]

      if (allErrors.length > 0) {
        console.error(formatErrors(allErrors))
        throw new Error('Znight compilation failed')
      }

      console.log('   ✓ All dependencies valid')

      // Generate container code
      console.log('⚙️  Generating container...')
      const generator = new ContainerGenerator()
      const code = generator.generate(providers)

      // Write output file
      const outputFilePath = join(root, outputPath)
      const outputDir = dirname(outputFilePath)

      await mkdir(outputDir, { recursive: true })
      writeFileSync(outputFilePath, code, 'utf-8')

      console.log(`   ✓ Generated ${outputPath}`)
      console.log('\n✨ Znight compilation complete!\n')
    },

    handleHotUpdate({ file }) {
      // In dev mode, re-run compilation when TypeScript files change
      if (file.endsWith('.ts') && !file.includes('node_modules')) {
        console.log('\n🔄 File changed, recompiling...')

        // Trigger buildStart again
        this.buildStart?.call(this, {})
      }
    },
  }
}

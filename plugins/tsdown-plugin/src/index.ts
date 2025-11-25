import { dirname } from 'node:path'
import { type CreateNodesV2, createNodesFromFiles } from '@nx/devkit'

export type PluginOptions = {
  buildTargetName?: string
  devTargetName?: string
}

export const createNodesV2: CreateNodesV2<PluginOptions> = [
  '**/tsdown.config.ts',
  async (configFiles, options, context) => {
    return await createNodesFromFiles(
      configFile => createNodesInternal({ configFilePath: configFile, options }),
      configFiles,
      options,
      context,
    )
  },
]

function createNodesInternal(params: { configFilePath: string; options?: PluginOptions }) {
  const { configFilePath, options } = params
  const root = dirname(configFilePath)

  const base = {
    inputs: ['default', '^default', { externalDependencies: ['tsdown'] }],
    options: {
      cwd: '{projectRoot}',
      forwardAllArgs: true,
    },
  }

  // Project configuration to be merged into the rest of the Nx configuration
  return {
    projects: {
      [root]: {
        targets: {
          [options?.buildTargetName ?? 'tsdown:build']: {
            // Nx target syntax to execute a command. More on {projectRoot} below
            cache: true,
            command: 'tsdown build',
            ...base,
          },
          [options?.devTargetName ?? 'tsdown:dev']: {
            // Nx target syntax to execute a command. More on {projectRoot} below
            command: 'tsdown build --watch',
            ...base,
            continuous: true,
          },
        },
      },
    },
  }
}

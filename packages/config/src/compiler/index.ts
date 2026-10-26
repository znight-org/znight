/**
 * `@znight/config/compiler`: the compiler extension of `@znight/config` (declared in the package
 * manifest, loaded by `@znight/compiler`).
 *
 * - `@Config(prefix?)` classes become singleton providers created by
 *   `loadConfig(Class, configSource, fields)`, the `ConfigSource` being an optional dependency
 *   (external provided by `ConfigPlugin`);
 * - their properties become field definitions (`metadata.extensions.config`, spec §9.3);
 * - misuses are reported at build time (ZNIGHT012, ZNIGHT005).
 *
 * This entry only `import type`s from `@znight/compiler` and never imports the runtime entry of
 * `@znight/config` (only its import-free modules `conventions.ts` and `coerce.ts`).
 */
import type { CompilerExtension, DecoratorSpec } from '@znight/compiler'
import type { StoredConfigData } from './analyze.ts'

import { CONFIG_EXTENSION_NAME } from '../conventions.ts'
import { analyzeConfigClass, ConfigDecorator, validateConfigData } from './analyze.ts'
import { generateConfigSection } from './generate.ts'

export type { ConfigFieldData, StoredConfig, StoredConfigData, StoredOrphan } from './analyze.ts'

export { ConfigDecorator } from './analyze.ts'

/** `@Config(prefix?)`: classes, one optional static argument. */
const CLASS_SPEC: DecoratorSpec = { targets: ['class'], params: ['static'] }

/** `@Env(name)`, `@Secret(name?)`, `@Default(value)`, `@Key(path)`: properties, one static argument. */
const PROPERTY_SPEC: DecoratorSpec = { targets: ['property'], params: ['static'] }

/** The config compiler extension (`apiVersion` 1, name `'config'`). */
export const configExtension: CompilerExtension<StoredConfigData> = Object.freeze({
  apiVersion: 1,
  name: CONFIG_EXTENSION_NAME,
  decorators: Object.freeze({
    [ConfigDecorator.Config]: CLASS_SPEC,
    [ConfigDecorator.Env]: PROPERTY_SPEC,
    [ConfigDecorator.Secret]: PROPERTY_SPEC,
    [ConfigDecorator.Default]: PROPERTY_SPEC,
    [ConfigDecorator.Key]: PROPERTY_SPEC,
  }),
  analyzeClass: analyzeConfigClass,
  validate: validateConfigData,
  generate: generateConfigSection,
})

export default configExtension

import { Config } from '@znight/config'

/** Settings of the catalogue, read from `CATALOG_<PROPERTY>`. */
@Config('catalog')
export class CatalogConfig {
  /** Start with a few sample products (`CATALOG_SEED=true`, set in `.env.development`). */
  seed = false
}

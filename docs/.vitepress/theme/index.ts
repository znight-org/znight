import type { Theme } from 'vitepress'

import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'

import { BenchmarkHighlights } from './benchmark-highlights.ts'
import { QuickStart } from './quick-start.ts'
import './custom.css'

/**
 * The default VitePress theme with the Znight brand colors, the create command in the home hero and
 * the benchmark highlights under the home features (`<BenchmarkHighlights />` in pages).
 */
const theme: Theme = {
  extends: DefaultTheme,
  Layout: () =>
    h(DefaultTheme.Layout, null, {
      'home-hero-actions-after': () => h(QuickStart),
      'home-features-after': () => h(BenchmarkHighlights, { home: true }),
    }),
  enhanceApp({ app }) {
    app.component('BenchmarkHighlights', BenchmarkHighlights)
  },
}

export default theme

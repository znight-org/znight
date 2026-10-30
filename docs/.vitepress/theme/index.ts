import type { Theme } from 'vitepress'

import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'

import { QuickStart } from './quick-start.ts'
import './custom.css'

/** The default VitePress theme with the Znight brand colors, and the create command in the home hero. */
const theme: Theme = {
  extends: DefaultTheme,
  Layout: () => h(DefaultTheme.Layout, null, { 'home-hero-actions-after': () => h(QuickStart) }),
}

export default theme

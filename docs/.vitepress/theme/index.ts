import type { Theme } from 'vitepress'

import DefaultTheme from 'vitepress/theme'

import './custom.css'

/** The default VitePress theme with the Znight brand colors. */
const theme: Theme = {
  extends: DefaultTheme,
}

export default theme

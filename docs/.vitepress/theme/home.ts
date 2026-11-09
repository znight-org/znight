import type { VNode } from 'vue'
import type { HomePackage } from './home-data.ts'

import { withBase } from 'vitepress'
import { defineComponent, h } from 'vue'

import { BASE_PACKAGES, EXAMPLES, PACKAGES, STEPS } from './home-data.ts'

/** A 24×24 line icon, decorative: the text next to it names what it stands for. */
function icon(markup: string, className: string): VNode {
  return h('svg', {
    class: className,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    innerHTML: markup,
  })
}

function tags(items: readonly string[], className: string): VNode | null {
  if (items.length === 0) return null
  return h(
    'ul',
    { class: className },
    items.map(item => h('li', item)),
  )
}

/** The three steps from source classes to a running application (`<HowItWorks />`). */
export const HowItWorks = defineComponent({
  name: 'HowItWorks',
  setup() {
    return () =>
      h(
        'ol',
        { class: 'zn-steps' },
        STEPS.map((step, index) =>
          h('li', { class: 'zn-step' }, [
            h('div', { class: 'zn-step-head' }, [
              h('span', { class: 'zn-step-number', 'aria-hidden': 'true' }, String(index + 1).padStart(2, '0')),
              h('span', { class: 'zn-step-icon' }, [icon(step.icon, 'zn-icon')]),
            ]),
            h('h3', { class: 'zn-step-title' }, step.title),
            h('p', { class: 'zn-step-text' }, step.text),
            h('a', { class: 'zn-step-link', href: withBase(step.link) }, [
              step.linkText,
              h('span', { 'aria-hidden': 'true' }, ' →'),
            ]),
          ]),
        ),
      )
  },
})

function packageTile(pkg: HomePackage, className: string): VNode {
  return h('li', { class: 'zn-tile-item' }, [
    h('a', { class: className, href: withBase(`/packages/${pkg.name}`) }, [
      h('span', { class: 'zn-tile-icon' }, [icon(pkg.icon, 'zn-icon')]),
      h('span', { class: 'zn-tile-body' }, [
        h('span', { class: 'zn-tile-title' }, [h('span', { class: 'zn-tile-scope' }, '@znight/'), pkg.name]),
        h('span', { class: 'zn-tile-text' }, pkg.text),
        tags(pkg.tags, 'zn-tags'),
      ]),
    ]),
  ])
}

/**
 * One tile per package, each linking to its page (`<PackageGrid />`): the two base packages on a
 * row of their own, then the feature packages and a tile for the packages overview.
 */
export const PackageGrid = defineComponent({
  name: 'PackageGrid',
  setup() {
    return () =>
      h('div', { class: 'zn-packages' }, [
        h('div', { class: 'zn-packages-base' }, [
          h('p', { class: 'zn-packages-base-label', id: 'zn-packages-base-label' }, 'The base of every application'),
          h(
            'ul',
            { class: 'zn-packages-base-list', 'aria-labelledby': 'zn-packages-base-label' },
            BASE_PACKAGES.map(pkg => packageTile(pkg, 'zn-tile zn-tile-base')),
          ),
        ]),
        h('ul', { class: 'zn-tiles', 'aria-label': 'Feature packages' }, [
          ...PACKAGES.map(pkg => packageTile(pkg, 'zn-tile')),
          h('li', { class: 'zn-tile-item' }, [
            h('a', { class: 'zn-tile zn-tile-more', href: withBase('/packages/') }, [
              h('span', { class: 'zn-tile-title' }, 'All packages'),
              h(
                'span',
                { class: 'zn-tile-text' },
                'What each one gives you, how to install it, and what is deliberately not a package.',
              ),
              h('span', { class: 'zn-tile-cta', 'aria-hidden': 'true' }, 'Compare them →'),
            ]),
          ]),
        ]),
      ])
  },
})

/** One card per example application, linking to its section of `/examples` (`<ExampleGrid />`). */
export const ExampleGrid = defineComponent({
  name: 'ExampleGrid',
  setup() {
    return () =>
      h(
        'ul',
        { class: 'zn-examples', 'aria-label': 'Example applications' },
        EXAMPLES.map(example =>
          h('li', { class: 'zn-tile-item' }, [
            h('a', { class: 'zn-example', href: withBase(`/examples#${example.name}`) }, [
              h('span', { class: 'zn-example-title' }, example.name),
              h('span', { class: 'zn-example-text' }, example.text),
              tags(example.tags, 'zn-tags'),
            ]),
          ]),
        ),
      )
  },
})

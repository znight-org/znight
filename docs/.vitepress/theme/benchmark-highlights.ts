import { withBase } from 'vitepress'
import { defineComponent, h } from 'vue'

// Written by `bun run --cwd benchmarks report` from benchmarks/results/results.json
import data from './benchmarks.json'

/** The shape of `Highlights` in benchmarks/src/highlights.ts. */
interface Highlights {
  readonly items: readonly { readonly value: string; readonly label: string; readonly detail: string }[]
  readonly context: string
}

const HIGHLIGHTS: Highlights = data

/**
 * The headline numbers of the benchmarks: a full-width band under the features of the home page
 * (`home`), or the numbers alone at the top of the benchmarks page.
 */
export const BenchmarkHighlights = defineComponent({
  name: 'BenchmarkHighlights',
  props: { home: { type: Boolean, default: false } },
  setup(props) {
    return () => {
      if (HIGHLIGHTS.items.length === 0) return null
      const grid = h(
        'div',
        { class: 'zn-bench-grid' },
        HIGHLIGHTS.items.map(item =>
          h('div', { class: 'zn-bench-item' }, [
            h('div', { class: 'zn-bench-value' }, item.value),
            h('div', { class: 'zn-bench-label' }, item.label),
            h('div', { class: 'zn-bench-detail' }, item.detail),
          ]),
        ),
      )
      const context = h('p', { class: 'zn-bench-context' }, [
        HIGHLIGHTS.context,
        props.home ? ' · ' : null,
        props.home ? h('a', { href: withBase('/benchmarks') }, 'Every result, and where Znight is slower →') : null,
      ])
      if (!props.home) return h('div', { class: 'zn-bench zn-bench-page' }, [grid, context])
      return h('section', { class: 'zn-bench zn-bench-home', 'aria-labelledby': 'zn-bench-title' }, [
        h('div', { class: 'zn-bench-container' }, [
          h('p', { class: 'zn-bench-eyebrow' }, 'Benchmarks'),
          h('h2', { class: 'zn-bench-title', id: 'zn-bench-title' }, 'Solved at build time. Fast at boot.'),
          h(
            'p',
            { class: 'zn-bench-lead' },
            'No metadata to reflect, no graph to sort: a Znight application imports its container and calls its factories.',
          ),
          grid,
          context,
        ]),
      ])
    }
  },
})

import { defineComponent, h, ref } from 'vue'

/** How each package manager runs the CLI, as in the getting started guide. */
const COMMANDS = [
  { manager: 'npm', command: 'npx @znight/cli new my-service' },
  { manager: 'pnpm', command: 'pnpm dlx @znight/cli new my-service' },
  { manager: 'bun', command: 'bunx @znight/cli new my-service' },
] as const

const COPIED_MS = 2000

/**
 * The command that creates an application, one tab per package manager, with a copy button. The
 * theme renders it under the actions of the home page hero.
 */
export const QuickStart = defineComponent({
  name: 'QuickStart',
  setup() {
    const selected = ref(0)
    const copied = ref(false)
    let reset: ReturnType<typeof setTimeout> | undefined

    async function copy(command: string): Promise<void> {
      await navigator.clipboard.writeText(command)
      copied.value = true
      clearTimeout(reset)
      reset = setTimeout(() => {
        copied.value = false
      }, COPIED_MS)
    }

    return () => {
      const current = COMMANDS[selected.value] ?? COMMANDS[0]
      return h('div', { class: 'zn-quick-start' }, [
        h(
          'div',
          { class: 'zn-quick-start-tabs', role: 'tablist', 'aria-label': 'Package manager' },
          COMMANDS.map((entry, index) =>
            h(
              'button',
              {
                type: 'button',
                role: 'tab',
                'aria-selected': index === selected.value,
                class: { active: index === selected.value },
                onClick: () => {
                  selected.value = index
                },
              },
              entry.manager,
            ),
          ),
        ),
        h('div', { class: 'zn-quick-start-command', role: 'tabpanel' }, [
          h('code', [h('span', { class: 'zn-quick-start-prompt', 'aria-hidden': 'true' }, '$ '), current.command]),
          h(
            'button',
            {
              type: 'button',
              class: 'zn-quick-start-copy',
              'aria-label': copied.value ? 'Copied' : 'Copy the command',
              onClick: () => copy(current.command),
            },
            copied.value ? 'Copied' : 'Copy',
          ),
        ]),
      ])
    }
  },
})

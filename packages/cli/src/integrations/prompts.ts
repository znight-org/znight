/**
 * Interactive prompts of `znight new`, backed by `@clack/prompts` (loaded lazily). A cancelled
 * prompt (Ctrl+C, Escape) throws a {@link CancelledError}.
 */
import { CancelledError } from '../errors.ts'

/** A choice of a select / multiselect prompt. */
export interface PromptChoice<T extends string> {
  readonly value: T
  readonly label: string
  readonly hint?: string
}

/** Prompts used by the CLI. */
export interface Prompts {
  intro(title: string): void
  outro(message: string): void
  text(options: {
    message: string
    placeholder?: string
    initialValue?: string
    validate?: (value: string) => string | undefined
  }): Promise<string>
  select<T extends string>(options: {
    message: string
    choices: readonly PromptChoice<T>[]
    initialValue?: T
  }): Promise<T>
  multiselect<T extends string>(options: {
    message: string
    choices: readonly PromptChoice<T>[]
    initialValues?: readonly T[]
  }): Promise<T[]>
  confirm(options: { message: string; initialValue?: boolean }): Promise<boolean>
  /** A spinner; `stop` prints the final message. */
  spinner(): { start(message: string): void; stop(message: string, failed?: boolean): void }
  note(message: string, title?: string): void
}

/** Loads `@clack/prompts` and adapts it to {@link Prompts}. */
export async function loadPrompts(): Promise<Prompts> {
  const clack = await import('@clack/prompts')
  const unwrap = <T>(value: T): Exclude<T, symbol> => {
    if (clack.isCancel(value) || typeof value === 'symbol') throw new CancelledError('Operation cancelled')
    return value as Exclude<T, symbol>
  }
  const toOptions = (choices: readonly PromptChoice<string>[]): { value: string; label: string; hint?: string }[] =>
    choices.map(choice => ({
      value: choice.value,
      label: choice.label,
      ...(choice.hint === undefined ? {} : { hint: choice.hint }),
    }))
  return {
    intro: title => clack.intro(title),
    outro: message => clack.outro(message),
    text: async options =>
      unwrap(
        await clack.text({
          message: options.message,
          ...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
          ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
          ...(options.validate === undefined
            ? {}
            : { validate: (value: string | undefined) => options.validate?.(value ?? '') }),
        }),
      ),
    select: async <T extends string>(options: {
      message: string
      choices: readonly PromptChoice<T>[]
      initialValue?: T
    }): Promise<T> => {
      const value = await clack.select<string>({
        message: options.message,
        options: toOptions(options.choices),
        ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
      })
      return unwrap(value) as T
    },
    multiselect: async <T extends string>(options: {
      message: string
      choices: readonly PromptChoice<T>[]
      initialValues?: readonly T[]
    }): Promise<T[]> => {
      const value = await clack.multiselect<string>({
        message: options.message,
        required: false,
        options: toOptions(options.choices),
        ...(options.initialValues === undefined ? {} : { initialValues: [...options.initialValues] }),
      })
      return unwrap(value) as T[]
    },
    confirm: async options =>
      unwrap(
        await clack.confirm({
          message: options.message,
          ...(options.initialValue === undefined ? {} : { initialValue: options.initialValue }),
        }),
      ),
    spinner: () => {
      const spinner = clack.spinner()
      return {
        start: message => spinner.start(message),
        stop: (message, failed = false) => (failed ? spinner.error(message) : spinner.stop(message)),
      }
    },
    note: (message, title) => clack.note(message, title),
  }
}

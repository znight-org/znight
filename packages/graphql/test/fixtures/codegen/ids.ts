import { scalar } from '@znight/graphql'

/** The TypeScript type graphql-codegen maps the `EventId` scalar to (`scalars: { EventId: './ids.ts#EventId' }`). */
export type EventId = string & { readonly __brand: 'EventId' }

export const EventIdScalar = scalar<EventId>('EventId', {
  description: 'Ignored in schema-first mode: the SDL description wins.',
  serialize: value => value as EventId,
  parseValue: value => {
    if (typeof value !== 'string' || !value.startsWith('evt_')) throw new TypeError('An event id starts with evt_')
    return value as EventId
  },
})

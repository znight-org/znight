import type { EventId } from './ids.ts'

import { Args, Mutation, Parent, Query, ResolveField, Resolver } from '@znight/graphql'

import {
  type CreateEventResult,
  type Event,
  EventStatus,
  type Maybe,
  type MutationCreateEventArgs,
  type Node,
  type QueryEventArgs,
  type QueryEventsArgs,
  type QueryNodeArgs,
  type User,
} from './graphql.generated.ts'

const OWNER: User = { __typename: 'User', id: 'u1', name: 'Ada' }

const EVENTS: Event[] = [
  {
    __typename: 'Event',
    id: '1',
    eventId: 'evt_1' as EventId,
    title: 'Launch',
    status: EventStatus.PUBLISHED,
    startsAt: new Date('2026-11-03T18:00:00.000Z'),
    tags: ['release'],
    owner: OWNER,
  },
]

/** Root fields typed with the graphql-codegen types: arguments and results. */
@Resolver()
export class EventResolver {
  @Query()
  event(@Args('id') id: QueryEventArgs['id']): Promise<Maybe<Event>> {
    return Promise.resolve(EVENTS.find(event => event.eventId === id) ?? null)
  }

  @Query()
  events(
    @Args('filter') filter: QueryEventsArgs['filter'],
    @Args('limit') limit: QueryEventsArgs['limit'],
  ): Promise<Event[]> {
    return Promise.resolve(
      EVENTS.filter(event => filter?.status == null || event.status === filter.status).slice(0, limit ?? 20),
    )
  }

  @Query()
  node(@Args() args: QueryNodeArgs): Maybe<Node> {
    return EVENTS.find(event => event.id === args.id) ?? (OWNER.id === args.id ? OWNER : null)
  }

  @Mutation()
  createEvent(@Args('input') input: MutationCreateEventArgs['input']): Promise<CreateEventResult> {
    if (input.title.trim() === '') {
      return Promise.resolve({ __typename: 'ValidationRejection', message: 'Invalid', fields: ['title'] })
    }
    const event: Event = {
      __typename: 'Event',
      id: String(EVENTS.length + 1),
      eventId: `evt_${EVENTS.length + 1}` as EventId,
      title: input.title,
      description: input.description ?? null,
      status: input.status ?? EventStatus.DRAFT,
      startsAt: new Date('2026-12-01T18:00:00.000Z'),
      tags: input.tags ?? [],
      owner: OWNER,
    }
    EVENTS.push(event)
    return Promise.resolve(event)
  }
}

/** A field resolver typed with the generated parent type. */
@Resolver('Event')
export class EventFieldResolver {
  @ResolveField()
  owner(@Parent() event: Event): User {
    return event.owner
  }
}

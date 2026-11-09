/**
 * The diagnostics of schema-first mode (RFC 0007 §5.2, §5.3, §8): the SDL itself (ZNIGHT067) and
 * the coverage of the SDL by the resolvers (ZNIGHT068), each with its location (in the `.graphql`
 * file or the TypeScript source), its hint and its related location; the reused codes.
 */

import { definesNothing } from '../../src/compiler/sdl-source.ts'
import { analyzeFiles, analyzeSchemaFirst, cleanupApps, formatted, render, SCHEMA_FIRST_CODES } from './helpers.ts'
import { afterAll, describe, expect, test as it } from 'bun:test'

afterAll(cleanupApps)

const MODEL = `export interface Book { id: string; title: string; authorId: string }
export interface Author { id: string; name: string }
`

/** A resolver file: `body` inside `@Resolver(${resolver})`. */
function resolver(body: string, resolverArgs = '', name = 'BookResolver'): string {
  return `import { Args, Mutation, Parent, Query, ResolveField, Resolver, Subscription } from '@znight/graphql'
import type { Author, Book } from './model.ts'

@Resolver(${resolverArgs})
export class ${name} {
${body}
}

void [Args, Mutation, Parent, Query, ResolveField, Subscription]
void (0 as unknown as [Author, Book])
`
}

const BOOK_QUERY = `  @Query()
  book(@Args('id') id: string): Book | null {
    return null
  }`

const SDL = `type Book {
  id: ID!
  title: String!
}

type Query {
  book(id: ID!): Book
}
`

async function diagnostics(files: Record<string, string>, options: Parameters<typeof analyzeSchemaFirst>[1] = {}) {
  return render(await analyzeSchemaFirst({ 'src/model.ts': MODEL, ...files }, options), SCHEMA_FIRST_CODES)
}

describe('ZNIGHT067: the SDL', () => {
  it('no file matches the globs', async () => {
    expect(await diagnostics({ 'src/book.resolver.ts': resolver(BOOK_QUERY) }, { schema: 'schema/*.graphql' })).toEqual(
      [
        `error ZNIGHT067 - No GraphQL schema file matches 'schema/*.graphql' (schema-first)
  = The globs of graphql.configure({ schema }) are relative to the project root: 'src/**/*.graphql'
  = Remove the schema option to derive the schema from the TypeScript types (code-first)`,
      ],
    )
  })

  it('a syntax error, at its position', async () => {
    const result = await diagnostics({
      'src/schema.graphql': 'type Query {\n  book(id: ID!): Book\n',
      'src/book.resolver.ts': resolver(BOOK_QUERY),
    })
    expect(result).toEqual([
      'error ZNIGHT067 src/schema.graphql:3:1 Syntax Error: Expected Name, found <EOF>. (src/schema.graphql)',
    ])
  })

  it('a type defined twice, across files', async () => {
    expect(
      await diagnostics({
        'src/a.graphql': SDL,
        'src/b.graphql': 'type Book {\n  isbn: String\n}\n',
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT067 src/b.graphql:1:6 The type Book is defined twice
  = Extend it instead (extend type Book { ... }), or rename one of them
  - first declared here (src/a.graphql:1:6)`,
    ])
  })

  it('unknown types, with a suggestion', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}type Author {\n  books: [Bok!]!\n  tags(first: Int, after: Cursor): [String!]!\n}\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT067 src/schema.graphql:10:11 Unknown type Bok (Author.books)
  = Did you mean Book?`,
      `error ZNIGHT067 src/schema.graphql:11:27 Unknown type Cursor (Author.tags(after:))
  = Define it, or fix the name`,
    ])
  })

  it('extensions of missing types and of another kind', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}extend type Boook {\n  isbn: String\n}\nextend input Book {\n  isbn: String\n}\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT067 src/schema.graphql:9:13 Cannot extend type Boook: it is not defined
  = Did you mean Book?`,
      `error ZNIGHT067 src/schema.graphql:12:14 Cannot extend Book as an input: it is a type
  = Use extend type Book { ... }
  - first declared here (src/schema.graphql:1:6)`,
    ])
  })

  it('duplicate fields, arguments and enum values, across extensions', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}extend type Book {\n  title: String\n}\nenum Genre {\n  FANTASY\n  FANTASY\n}\ntype Author {\n  books(first: Int, first: Int): [Book!]!\n}\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT067 src/schema.graphql:10:3 Book.title is declared twice
  = Keep one field named title
  - first declared here (src/schema.graphql:3:3)`,
      `error ZNIGHT067 src/schema.graphql:14:3 Genre.FANTASY is declared twice
  = Keep one value named FANTASY
  - first declared here (src/schema.graphql:13:3)`,
      `error ZNIGHT067 src/schema.graphql:17:21 Argument Author.books(first:) is declared twice
  - first declared here (src/schema.graphql:17:9)`,
    ])
  })

  it('graphql-js schema validation, located', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}interface Node {\n  id: ID!\n}\ntype Author implements Node {\n  name: String!\n}\nunion Result = Book | String\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT067 src/schema.graphql:10:3 Invalid schema: Interface field Node.id expected but Author does not provide it.
  - see also (src/schema.graphql:12:6)`,
      'error ZNIGHT067 src/schema.graphql:15:23 Invalid schema: Union type Result can only include Object types, it cannot include String.',
    ])
  })

  it('unknown directives; custom directives and built-in scalar overrides are warnings', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `directive @resolved on FIELD_DEFINITION
"""When."""
scalar DateTime @specifiedBy(url: "https://example.com")
type Book {
  id: ID! @key
  title: String! @resolved
}
input When {
  at: DateTime
}
type Query {
  book(id: ID!): Book
}
`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `warning ZNIGHT067 src/schema.graphql:1:12 The custom directive @resolved is ignored
  = Znight serves the schema without custom directives (and so does the SDL artifact): remove it, or keep it for other tools`,
      `error ZNIGHT067 src/schema.graphql:5:12 Unknown directive @key
  = Define it (directive @key on FIELD_DEFINITION), or remove it`,
    ])
    expect(
      await diagnostics({
        'src/schema.graphql': `"""When."""\nscalar DateTime\ninput When {\n  at: DateTime\n}\n${SDL}`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `warning ZNIGHT067 src/schema.graphql:2:8 scalar DateTime is the built-in scalar of @znight/graphql: its description and @specifiedBy in the SDL are ignored
  = Remove them, or implement the scalar yourself: export const DateTimeScalar = scalar<T>('DateTime', { ... })`,
    ])
  })

  it('a scalar without scalar() definition, and @oneOf inputs', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}scalar EventId\ninput Pick @oneOf {\n  a: Int\n  b: String\n}\nextend type Query {\n  event(id: EventId!, pick: Pick): String\n}\n`,
        'src/book.resolver.ts': resolver(`${BOOK_QUERY}

  @Query()
  event(@Args('id') id: string): string {
    return id
  }`),
      }),
    ).toEqual([
      `error ZNIGHT067 src/schema.graphql:9:8 scalar EventId has no implementation: declare it with scalar<T>('EventId', ...)
  = export const EventIdScalar = scalar<EventId>('EventId', { serialize: value => value as EventId, parseValue: value => value as EventId }), with EventId the TypeScript type of its values (the one graphql-codegen maps it to)`,
      `error ZNIGHT067 src/schema.graphql:10:7 @oneOf input objects are not supported yet (Pick)
  = Declare one optional field per case and check that exactly one is set in the resolver`,
    ])
  })

  it('prints code frames in the .graphql files', async () => {
    const result = await analyzeSchemaFirst({
      'src/model.ts': MODEL,
      'src/schema.graphql': `${SDL}extend type Query {\n  books: [Bok!]!\n}\n`,
      'src/book.resolver.ts': resolver(BOOK_QUERY),
    })
    expect(formatted(result, SCHEMA_FIRST_CODES)).toBe(`✗ ZNIGHT067: Unknown type Bok (Query.books)
  --> src/schema.graphql:10:11
   |
10 |   books: [Bok!]!
   |           ^^^
   = hint: Did you mean Book?`)
  })
})

describe('ZNIGHT068: coverage', () => {
  it('a root field without resolver', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}type Mutation {\n  addBook(title: String!): Book!\n}\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT068 src/schema.graphql:10:3 Root field Mutation.addBook has no resolver
  = Add a method to a @Resolver() class: @Mutation() addBook(...) (or @Mutation('addBook') on another method)`,
    ])
  })

  it('a resolver for a field the SDL does not declare, with a suggestion or the right root type', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}type Mutation {\n  addBook(title: String!): Book!\n}\n`,
        'src/book.resolver.ts': resolver(`${BOOK_QUERY}

  @Query()
  bok(): Book | null {
    return null
  }

  @Query('addBook')
  add(@Args('title') title: string): Book {
    return { id: '1', title, authorId: 'a' }
  }

  @Mutation()
  addBook(@Args('title') title: string): Book {
    return { id: '1', title, authorId: 'a' }
  }

  @Subscription()
  async *bookAdded(): AsyncGenerator<Book> {}`),
      }),
    ).toEqual([
      `error ZNIGHT068 src/book.resolver.ts:11:3 @Query BookResolver.bok: Query has no field 'bok'
  = Did you mean 'book'? @Query('book')
  = Declare it in the SDL (extend type Query { bok: ... }), or remove the method`,
      `error ZNIGHT068 src/book.resolver.ts:16:3 @Query BookResolver.add: Query has no field 'addBook'
  = Mutation.addBook exists: use @Mutation()
  = Declare it in the SDL (extend type Query { addBook: ... }), or remove the method`,
      `error ZNIGHT068 src/book.resolver.ts:26:3 @Subscription BookResolver.bookAdded: the schema has no Subscription type
  = Declare it in the SDL: type Subscription { bookAdded: ... }`,
    ])
  })

  it('@Resolver naming a missing type, an interface, an enum or a root type', async () => {
    const field = `  @ResolveField()
  title(@Parent() book: Book): string {
    return book.title
  }`
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}interface Node {\n  id: ID!\n}\nenum Genre {\n  FANTASY\n}\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
        'src/a.resolver.ts': resolver(field, "'Bok'", 'A'),
        'src/b.resolver.ts': resolver(field, "'Node'", 'B'),
        'src/c.resolver.ts': resolver(field, "'Genre'", 'C'),
        'src/d.resolver.ts': resolver(field, "'Query'", 'D'),
      }),
    ).toEqual([
      `error ZNIGHT068 src/a.resolver.ts:4:11 @Resolver('Bok') of A: the schema has no type Bok
  = Did you mean 'Book'?`,
      `error ZNIGHT068 src/b.resolver.ts:4:11 @Resolver('Node') of B: Node is an interface, field resolvers bind the fields of object types
  = Declare an object type implementing Node and bind the field on it
  - Node is declared here (src/schema.graphql:9:11)`,
      `error ZNIGHT068 src/c.resolver.ts:4:11 @Resolver('Genre') of C: Genre is not an object type, it has no field to resolve
  = Name an object type of the SDL (type ... { ... })
  - Genre is declared here (src/schema.graphql:12:6)`,
      `error ZNIGHT068 src/d.resolver.ts:4:11 @Resolver('Query') of D: Query is the query root type, its fields are bound with @Query()
  = Replace @ResolveField() with @Query() and use @Resolver()
  - Query is declared here (src/schema.graphql:6:6)`,
    ])
  })

  it('a field resolver for a missing field, an unknown argument', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': SDL,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
        'src/fields.resolver.ts': resolver(
          `  @ResolveField()
  author(@Parent() book: Book): string {
    return book.authorId
  }

  @ResolveField('title')
  upper(@Parent() book: Book, @Args('casing') casing: string): string {
    return casing + book.title
  }`,
          "'Book'",
          'BookFields',
        ),
      }),
    ).toEqual([
      `error ZNIGHT068 src/fields.resolver.ts:6:3 @ResolveField BookFields.author: Book has no field 'author'
  = Declare it in the SDL (extend type Book { author: ... }), or remove the method`,
      `error ZNIGHT068 src/fields.resolver.ts:12:31 @Args('casing') on parameter 'casing' of BookFields.upper: Book.title has no argument 'casing'
  = Book.title takes no argument: declare it in the SDL, or remove the parameter
  - Book.title is declared here (src/schema.graphql:3:3)`,
    ])
  })

  it('an object field that neither a resolver nor the returned TypeScript type provides', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}extend type Book {\n  author: Author!\n  isbn: String\n}\ntype Author {\n  id: ID!\n  name: String!\n}\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT068 src/schema.graphql:10:3 Book.author has no resolver, and Book (returned by BookResolver.book) has no property 'author'
  = Add a field resolver: @ResolveField('author') in a @Resolver('Book') class
  = Or add 'author' to Book
  - Book is declared here (src/model.ts:1:18)`,
      `error ZNIGHT068 src/schema.graphql:11:3 Book.isbn has no resolver, and Book (returned by BookResolver.book) has no property 'isbn'
  = Add a field resolver: @ResolveField('isbn') in a @Resolver('Book') class
  = Or add 'isbn' to Book
  - Book is declared here (src/model.ts:1:18)`,
    ])
  })

  it('reuses ZNIGHT061 (two resolvers for one field) and ZNIGHT062 (@ResolveField without type)', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': SDL,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
        'src/other.resolver.ts': resolver(
          `${BOOK_QUERY}

  @ResolveField()
  title(@Parent() book: Book): string {
    return book.title
  }`,
          '',
          'Other',
        ),
      }),
    ).toEqual([
      `error ZNIGHT061 src/other.resolver.ts:6:3 Two resolvers bind Query.book: Other.book and BookResolver.book
  = Keep one of them
  - the other resolver (src/book.resolver.ts:6:3)`,
      `error ZNIGHT062 src/other.resolver.ts:11:3 @ResolveField Other.title needs the type it resolves a field of: name it in @Resolver (schema-first)
  = @Resolver('Event') on Other, where Event is the object type of the SDL declaring 'title'`,
    ])
  })

  it('code-first rejects a type name in @Resolver (ZNIGHT005)', async () => {
    const result = await analyzeFiles({ 'src/model.ts': MODEL, 'src/book.resolver.ts': resolver(BOOK_QUERY, "'Book'") })
    expect(render(result)).toEqual([
      `error ZNIGHT005 src/book.resolver.ts:4:11 @Resolver('Book'): naming the type is schema-first only, the code-first schema is derived from the types
  = Remove the type name: @ResolveField methods add fields to the type of their @Parent() parameter
  = Or switch to schema-first: graphql.configure({ schema: 'src/**/*.graphql' }) in znight.config.ts`,
    ])
  })
})

describe('cascades', () => {
  it('a resolver method with an analysis error does not also leave its field without resolver', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}extend type Book {\n  author: String\n}\n`,
        'src/book.resolver.ts': resolver(`  @Query()
  book(id: string): Book | null {
    return null
  }`),
        'src/fields.resolver.ts': resolver(
          `  @ResolveField()
  author(@Parent() book: Book, extra: string): string {
    return book.authorId + extra
  }`,
          "'Book'",
          'BookFields',
        ),
      }),
    ).toEqual([
      `error ZNIGHT005 src/book.resolver.ts:7:8 Parameter 'id' of BookResolver.book has no @Args(), @Parent(), @Ctx(), @Info() or @Loader() decorator
  = Every resolver parameter is filled by GraphQL: @Args(name?, schema?) for arguments, @Parent() for the parent object, @Ctx() for the GraphQLContext, @Info() for the GraphQLResolveInfo, @Loader() for a DataLoader`,
      `error ZNIGHT005 src/fields.resolver.ts:7:32 Parameter 'extra' of BookFields.author has no @Args(), @Parent(), @Ctx(), @Info() or @Loader() decorator
  = Every resolver parameter is filled by GraphQL: @Args(name?, schema?) for arguments, @Parent() for the parent object, @Ctx() for the GraphQLContext, @Info() for the GraphQLResolveInfo, @Loader() for a DataLoader`,
    ])
  })
})

describe('review fixes', () => {
  it('directives: executable ones, wrong locations, duplicates, unknown or missing arguments, duplicate roots', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}scalar Url @specifiedBy
extend type Book {
  isbn: String @deprecated @deprecated(why: "x") @skip(if: true)
}
enum Genre @deprecated {
  FANTASY
}
schema {
  query: Query
  query: Book
}
`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT067 src/schema.graphql:9:13 @specifiedBy needs its argument 'url'
  = @specifiedBy(url: ...)`,
      `error ZNIGHT067 src/schema.graphql:11:29 @deprecated is applied twice
  = Apply it once
  - first declared here (src/schema.graphql:11:17)`,
      `error ZNIGHT067 src/schema.graphql:11:40 @deprecated has no argument 'why'
  = Its arguments: reason`,
      `error ZNIGHT067 src/schema.graphql:11:51 @skip is an executable directive: it cannot be used in a schema
  = Remove it`,
      `error ZNIGHT067 src/schema.graphql:13:13 @deprecated cannot be used on enums
  = @deprecated applies to fields, arguments, input fields, enum values`,
      `error ZNIGHT067 src/schema.graphql:18:3 The query root type is declared twice
  = Keep one
  - first declared here (src/schema.graphql:17:3)`,
    ])
  })

  it('skips files without definitions; a schema of empty files only is reported', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': SDL,
        'src/empty.graphql': '',
        'src/notes.graphql': '# todo: the reviews\n',
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([])
    expect(await diagnostics({ 'src/empty.graphql': '\n', 'src/book.resolver.ts': resolver(BOOK_QUERY) })).toEqual([
      `error ZNIGHT067 - The GraphQL schema files matching 'src/**/*.graphql' define nothing (schema-first)
  = Declare the types of the schema, starting with type Query { ... }`,
    ])
  })

  it('compiles schema files that start with comment banners', async () => {
    const banner = '#'.repeat(80)
    expect(
      await diagnostics({
        'src/schema.graphql': `${banner}\n# Books\n${banner}\n${SDL}`,
        'src/notes.graphql': `${banner}\n# a\n## b\n,\n${banner}\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([])
  })

  it('tells a placeholder file in linear time, whatever its comment banners', () => {
    const banner = '#'.repeat(40)
    expect(definesNothing(`\uFEFF${banner}\n# a\n## b\n,\n${banner}\n`)).toBe(true)
    expect(definesNothing('')).toBe(true)
    expect(definesNothing('# todo\ntype Query { a: Int }\n')).toBe(false)
    const started = performance.now()
    for (let i = 0; i < 5; i++) {
      expect(definesNothing(`${banner}\n# Books\n${banner}\ntype Query { a: Int }\n`)).toBe(false)
    }
    expect(performance.now() - started).toBeLessThan(100)
  })

  it('a missing query root type, with a hint', async () => {
    expect(
      await diagnostics({ 'src/schema.graphql': 'type Book {\n  id: ID!\n}\n', 'src/book.resolver.ts': resolver('') }),
    ).toEqual([
      `error ZNIGHT067 - Invalid schema: Query root type must be provided.
  = Declare the query root type in one of the files: type Query { ... }`,
    ])
  })

  it('valid SDL hints for scalars and unions', async () => {
    expect(
      await diagnostics({
        'src/schema.graphql': `${SDL}scalar Url\nscalar Url\nextend union Hits = Book\n`,
        'src/book.resolver.ts': resolver(BOOK_QUERY),
      }),
    ).toEqual([
      `error ZNIGHT067 src/schema.graphql:10:8 The type Url is defined twice
  = Keep one of them, or rename one
  - first declared here (src/schema.graphql:9:8)`,
      `error ZNIGHT067 src/schema.graphql:11:14 Cannot extend union Hits: it is not defined
  = Define it: union Hits = ...`,
    ])
  })

  it('a class rejected by the analysis does not leave its fields without resolver', async () => {
    const files = {
      'src/schema.graphql': `${SDL}type Mutation {\n  addBook(title: String!): Book!\n}\n`,
      'src/book.resolver.ts': resolver(BOOK_QUERY),
      'src/abstract.resolver.ts': `import { Args, Mutation, Resolver } from '@znight/graphql'
import type { Book } from './model.ts'

@Resolver()
export abstract class Base {
  @Mutation()
  addBook(@Args('title') title: string): Book {
    return { id: '1', title, authorId: 'a' }
  }
}
`,
    }
    expect(await diagnostics(files)).toEqual([
      `error ZNIGHT005 src/abstract.resolver.ts:4:1 @Resolver cannot be applied to the abstract class Base
  = Resolvers are instantiated: remove \`abstract\``,
    ])
  })
})

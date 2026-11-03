import type { Author, Book } from '../catalog/book.js'

// A named union of object types: the compiler finds how graphql-js tells the members apart at
// runtime, here the `kind` property, whose literal type differs in every member (ZNIGHT064 otherwise).
/** A search hit: a book or an author. */
export type SearchResult = Book | Author

import * as entry from '../src/index.ts'
import { expect, test as it } from 'bun:test'

it('the public entry can be imported', () => {
  expect(entry).toBeDefined()
})

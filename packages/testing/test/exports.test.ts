import * as entry from '../src/index.ts'
import { expect, test as it } from 'bun:test'

it('exposes the public runtime API', () => {
  expect(Object.keys(entry).sort()).toEqual([
    'HTTP_PLUGIN_NAME',
    'TestApp',
    'TestBed',
    'clearMock',
    'createMetadata',
    'createMock',
    'createSpy',
    'defineTestMetadata',
    'detectMockFn',
    'isBuiltinSpy',
    'isMock',
    'override',
    'overrideFactory',
    'resetMock',
    'resolveMockFn',
    'setDefaultMockFn',
    'testToken',
  ])
})

it('TestBed and TestApp cannot be instantiated directly', () => {
  expect(typeof entry.TestBed.create).toBe('function')
  expect(typeof entry.TestApp.create).toBe('function')
  expect(entry.HTTP_PLUGIN_NAME).toBe('http')
})

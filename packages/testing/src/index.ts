/**
 * `@znight/testing`: unit tests with auto-mocked dependencies (`TestBed`), end-to-end tests of a
 * started application (`TestApp`), deep auto-mocks and a Jest-compatible spy that cooperate with
 * Vitest, Jest and `bun:test`.
 */
export type { ConfigProperties, ConfigValues } from './config.ts'
export type { MockRegistry } from './mock-registry.ts'
export type {
  AnyFunction,
  DeepMock,
  DeepMockFunction,
  Mocked,
  MockedMember,
  MockFnFactory,
  MockFnOption,
  MockFunction,
  MockResult,
  MockState,
  UntypedFunction,
} from './types.ts'

export {
  type CreateMetadataOptions,
  createMetadata,
  defineTestMetadata,
  type TestDependency,
  type TestKey,
  type TestMetadataSpec,
  type TestProvider,
  testToken,
} from './define-metadata.ts'
export { type CreateMockOptions, clearMock, createMock, isMock, resetMock } from './mock.ts'
export { detectMockFn, type MockFnSource, type ResolvedMockFn, resolveMockFn, setDefaultMockFn } from './mock-fn.ts'
export {
  type OverrideDefinitionEntry,
  type OverrideEntry,
  type OverrideFactoryOptions,
  override,
  overrideFactory,
} from './overrides.ts'
export { createSpy, isBuiltinSpy } from './spy.ts'
export {
  HTTP_PLUGIN_NAME,
  type HttpInjector,
  type HttpInjectResult,
  type InjectRequest,
  type InjectResponse,
  type PluginInitRoots,
  type SetCookieInfo,
  TestApp,
  type TestAppOptions,
} from './test-app.ts'
export { type AopMode, TestBed, type TestBedOptions, type TestBedResult } from './testbed.ts'

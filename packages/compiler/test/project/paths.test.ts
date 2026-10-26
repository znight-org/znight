import { compareStrings } from '../../src/project/compare.ts'
import {
  isBareSpecifier,
  isDeclarationPath,
  isRelativeSpecifier,
  isResolutionConfigPath,
  isTypeScriptSourcePath,
  packageNameOf,
  publicPackageName,
  relativePath,
  resolvePath,
  toPosixPath,
} from '../../src/project/index.ts'
import { isWithin } from '../../src/project/paths.ts'
import { describe, expect, test as it } from 'bun:test'

describe('paths', () => {
  it('toPosixPath converts backslashes', () => {
    expect(toPosixPath('C:\\repo\\src\\a.ts')).toBe('C:/repo/src/a.ts')
    expect(toPosixPath('/already/posix')).toBe('/already/posix')
  })

  it('resolvePath and relativePath work on POSIX paths', () => {
    expect(resolvePath('src/a.ts', '/root')).toBe('/root/src/a.ts')
    expect(relativePath('/root', '/root/src/a.ts')).toBe('src/a.ts')
    expect(relativePath('/root/src', '/root/lib/b.ts')).toBe('../lib/b.ts')
  })

  it('isWithin', () => {
    expect(isWithin('/root', '/root/a.ts')).toBe(true)
    expect(isWithin('/root', '/root')).toBe(true)
    expect(isWithin('/root', '/rootless/a.ts')).toBe(false)
    expect(isWithin('/root/', '/root/a.ts')).toBe(true)
  })

  it.each([
    ['./a', true, false],
    ['../a', true, false],
    ['.', true, false],
    ['/abs/a', true, false],
    ['C:\\abs', true, false],
    ['pkg', false, true],
    ['@scope/pkg/sub', false, true],
    ['node:fs', false, true],
    ['#internal', false, false],
  ])('specifier %s: relative=%p bare=%p', (specifier, relative, bare) => {
    expect(isRelativeSpecifier(specifier)).toBe(relative)
    expect(isBareSpecifier(specifier)).toBe(bare)
  })

  it('packageNameOf extracts the package of a bare specifier', () => {
    expect(packageNameOf('pg')).toBe('pg')
    expect(packageNameOf('pg/lib/client')).toBe('pg')
    expect(packageNameOf('@scope/pkg')).toBe('@scope/pkg')
    expect(packageNameOf('@scope/pkg/sub/path')).toBe('@scope/pkg')
  })

  it('publicPackageName maps DefinitelyTyped packages to the typed package', () => {
    expect(publicPackageName('@types/pg')).toBe('pg')
    expect(publicPackageName('@types/babel__core')).toBe('@babel/core')
    expect(publicPackageName('@acme/lib')).toBe('@acme/lib')
  })

  it('isDeclarationPath / isTypeScriptSourcePath', () => {
    for (const file of ['a.d.ts', 'a.d.mts', 'a.d.cts', 'styles.d.css.ts']) {
      expect(isDeclarationPath(`/x/${file}`)).toBe(true)
      expect(isTypeScriptSourcePath(`/x/${file}`)).toBe(false)
    }
    for (const file of ['a.ts', 'a.tsx', 'a.mts', 'a.cts']) {
      expect(isDeclarationPath(`/x/${file}`)).toBe(false)
      expect(isTypeScriptSourcePath(`/x/${file}`)).toBe(true)
    }
    expect(isTypeScriptSourcePath('/x/a.js')).toBe(false)
  })

  it('isResolutionConfigPath detects files that invalidate module resolution', () => {
    for (const file of [
      'package.json',
      'tsconfig.json',
      'tsconfig.app.json',
      'jsconfig.json',
      'bun.lock',
      'bun.lockb',
      'pnpm-lock.yaml',
      'yarn.lock',
      'package-lock.json',
    ]) {
      expect(isResolutionConfigPath(`/repo/${file}`)).toBe(true)
    }
    expect(isResolutionConfigPath('/repo/src/package.ts')).toBe(false)
    expect(isResolutionConfigPath('C:\\repo\\package.json')).toBe(true)
  })

  it('compareStrings is locale independent (code unit order)', () => {
    expect(['b', 'a', 'B', 'é', 'e'].sort(compareStrings)).toEqual(['B', 'a', 'b', 'e', 'é'])
    expect(compareStrings('a', 'a')).toBe(0)
  })
})

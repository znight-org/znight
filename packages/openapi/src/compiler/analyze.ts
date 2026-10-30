/**
 * `analyzeClass`: records the `@OpenApiDocument` class and the controllers carrying `@Api*`
 * decorators, and reports misplaced decorators (ZNIGHT030). The operations are built in
 * `validate`, from the route table of the http extension.
 */
import type { AnalyzeContext, ClassInfo, DecoratorInfo } from '@znight/compiler'
import type { OpenApiStored } from './model.ts'

import { Codes, EXTENSION_NAME, HttpIds, Ids, ROUTE_DECORATORS } from './model.ts'

/** `analyzeClass` of the extension. */
export function analyzeOpenApiClass(cls: ClassInfo, ctx: AnalyzeContext<OpenApiStored>): void {
  const owned = (decorators: readonly DecoratorInfo[]): DecoratorInfo[] =>
    decorators.filter(decorator => decorator.owner === EXTENSION_NAME)
  const document = cls.decorators.find(decorator => decorator.identity === Ids.OpenApiDocument)
  const controller = cls.decorators.some(decorator => decorator.identity === HttpIds.Controller)
  const members = [
    ...cls.methods.map(method => ({ decorators: owned(method.decorators), method })),
    ...cls.properties.map(property => ({ decorators: owned(property.decorators), method: undefined })),
  ]
  const misplaced = (decorator: DecoratorInfo, message: string, hints: readonly string[]): void => {
    ctx.report({
      code: Codes.InvalidOpenApiDefinition,
      severity: 'error',
      message,
      location: decorator.location,
      hints,
    })
  }
  if (document !== undefined) {
    if (controller) {
      misplaced(document, `@OpenApiDocument goes on a class of its own, not on the controller ${cls.displayName}`, [
        'Declare it on an empty class: @OpenApiDocument({...}) export class Api {}',
      ])
    }
    for (const decorator of owned(cls.decorators)) {
      if (decorator !== document && !controller) {
        misplaced(
          decorator,
          `@${decorator.name} applies to controllers and route handlers, not to the @OpenApiDocument class`,
          [],
        )
      }
    }
    ctx.store({ kind: 'document', identity: cls.identity, displayName: cls.displayName, location: document.location })
    if (!controller) return
  }
  if (!controller) {
    const consumer = cls.decorators.some(decorator => decorator.identity === '@znight/messaging#Consumer')
    const hints = consumer
      ? ['Message consumers are not documented by OpenAPI (AsyncAPI is not supported in v0.1)']
      : ['Add @Controller() to the class, or remove the decorator']
    for (const decorator of owned(cls.decorators)) {
      misplaced(decorator, `@${decorator.name} applies to controllers: ${cls.displayName} is not a @Controller`, hints)
    }
    for (const member of members) {
      for (const decorator of member.decorators) {
        misplaced(
          decorator,
          `@${decorator.name} applies to route handlers: ${cls.displayName} is not a @Controller`,
          hints,
        )
      }
    }
    return
  }
  for (const member of members) {
    const handler = member.method?.decorators.some(
      decorator => decorator.identity !== undefined && ROUTE_DECORATORS.has(decorator.identity),
    )
    if (handler === true) continue
    for (const decorator of member.decorators) {
      misplaced(
        decorator,
        `@${decorator.name} applies to route handlers: ${cls.displayName}.${member.method?.name ?? 'this member'} has no route decorator (@Get, @Post...)`,
        ['Add a route decorator, or move the decorator to a route handler'],
      )
    }
  }
  ctx.store({ kind: 'controller', identity: cls.identity, displayName: cls.displayName })
}

/**
 * The SDL view of the model (`sdl.ts` prints it), from which `schemaHash` and the SDL artifact
 * derive.
 */
import type { SdlInputValue, SdlType } from '../sdl.ts'
import type { ArgModel, TypeModel } from './model.ts'

/** The SDL view of a model type. */
export function sdlType(model: TypeModel): SdlType {
  const base = model.description === undefined ? {} : { description: model.description }
  switch (model.kind) {
    case 'object':
      return {
        kind: 'object',
        name: model.name,
        ...base,
        fields: model.fields.map(field => ({
          name: field.name,
          type: field.type,
          ...(field.description === undefined ? {} : { description: field.description }),
          ...(field.deprecationReason === undefined ? {} : { deprecationReason: field.deprecationReason }),
          ...(field.args.length === 0 ? {} : { args: field.args.map(sdlInputValue) }),
        })),
      }
    case 'input':
      return { kind: 'input', name: model.name, ...base, fields: model.fields.map(sdlInputValue) }
    case 'enum':
      return {
        kind: 'enum',
        name: model.name,
        ...base,
        values: model.values.map(value => ({
          name: value.name,
          ...(value.description === undefined ? {} : { description: value.description }),
          ...(value.deprecationReason === undefined ? {} : { deprecationReason: value.deprecationReason }),
        })),
      }
    case 'union':
      return { kind: 'union', name: model.name, ...base, members: model.members }
    case 'scalar':
      return {
        kind: 'scalar',
        name: model.name,
        ...base,
        ...(model.definition === undefined ? { builtin: true } : {}),
        ...(model.specifiedByURL === undefined ? {} : { specifiedByURL: model.specifiedByURL }),
      }
  }
}

function sdlInputValue(arg: ArgModel): SdlInputValue {
  return {
    name: arg.name,
    type: arg.type,
    ...(arg.description === undefined ? {} : { description: arg.description }),
    ...(arg.deprecationReason === undefined ? {} : { deprecationReason: arg.deprecationReason }),
    ...(arg.defaultValue === undefined ? {} : { defaultValue: arg.defaultValue }),
  }
}

/**
 * `@znight/openapi`: OpenAPI 3.1 documents built at compile time from the controllers of
 * `@znight/http` (types, JSDoc, Standard Schemas, a few `@Api*` decorators), served with Scalar or
 * Swagger UI by `OpenApiPlugin`, and emitted at build time (`znight openapi`).
 */
import './metadata.ts'

export type {
  OpenApiDocumentTemplate,
  OpenApiMetadata,
  OpenApiOperationDefinition,
  OpenApiSchemaSlot,
  OperationTemplate,
  ParametersPlaceholder,
  SchemaPlaceholder,
  SchemaTemplate,
} from './metadata.ts'
export type {
  ComponentsObject,
  ContactObject,
  EncodingObjectOf,
  ExampleObject,
  ExternalDocumentationObject,
  HeaderObject,
  HeaderObjectOf,
  InfoObject,
  JsonSchema,
  JsonValue,
  LicenseObject,
  MediaTypeObject,
  MediaTypeObjectOf,
  OAuthFlowObject,
  OAuthFlowsObject,
  OpenApiMethod,
  OpenApiObject,
  OperationObject,
  OperationObjectOf,
  ParameterLocation,
  ParameterObject,
  ParameterObjectOf,
  PathItemObject,
  ReferenceObject,
  RequestBodyObject,
  RequestBodyObjectOf,
  ResponseObject,
  ResponseObjectOf,
  SecurityRequirementObject,
  SecuritySchemeObject,
  ServerObject,
  ServerVariableObject,
  SpecificationExtensions,
  TagObject,
} from './types.ts'

export {
  type BuildOpenApiOptions,
  buildOpenApiDocument,
  type OpenApiBuildResult,
  type OpenApiOperationView,
  type OpenApiWarning,
} from './build.ts'
export {
  BUILT_IN_CONVERTERS,
  type SchemaConverter,
  type SchemaConverterContext,
  standardJsonSchemaConverter,
  valibotConverter,
} from './converters.ts'
export {
  ApiBody,
  type ApiBodyOptions,
  ApiExclude,
  ApiHeader,
  ApiOperation,
  type ApiOperationOptions,
  type ApiParameterOptions,
  ApiQuery,
  ApiResponse,
  type ApiResponseOptions,
  type ApiResponseStatus,
  ApiSecurity,
  ApiTags,
  OpenApiDocument,
  type OpenApiDocumentOptions,
  type OperationIdStyle,
  type SecurityDecision,
  type SecurityRequirementInput,
  type SecurityScheme,
  securityScheme,
} from './decorators.ts'
export { OPENAPI_METADATA_VERSION } from './metadata.ts'
export { OpenApi, OpenApiTokens } from './openapi.ts'
export { OpenApiPlugin, type OpenApiPluginOptions, type OpenApiUiOption } from './plugin.ts'
export { CDN_ORIGIN, UI_PACKAGES, type UiAsset, type UiKind, type UiPackage } from './ui.ts'

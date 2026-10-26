/**
 * `@znight/http`: controllers, routing, guards, interceptors and validation for Znight, with a
 * built-in `node:http` server and Fastify / Express / Hono adapters (subpath exports).
 */
export type {
  AdapterCloseOptions,
  AdapterHandler,
  AdapterReply,
  AdapterRequest,
  AdapterRoute,
  FallbackHandler,
  HttpAdapter,
  HttpServerAddress,
  InjectRequest,
  InjectResponse,
  ReplyBody,
} from './adapter.ts'
export type { HttpContext, HttpRouteInfo, RequestId } from './context.ts'
export type {
  CallHandler,
  CanActivate,
  ExceptionMapper,
  ExceptionMapperClass,
  ExceptionMapperResult,
  GuardClass,
  HttpInterceptor,
  HttpInterceptorClass,
} from './interfaces.ts'
export type {
  HttpControllerDefinition,
  HttpMetadata,
  HttpMethod,
  HttpParamDefinition,
  HttpParamSource,
  HttpRouteDefinition,
  HttpUploadDefinition,
} from './metadata.ts'
export type { ByteSize } from './size.ts'
export type { StreamSource } from './stream.ts'

export { type NodeAdapter, type NodeAdapterOptions, nodeAdapter } from './adapters/node.ts'
export { isJsonType, type MediaType, parseBody, parseMediaType } from './body.ts'
export { type Coercer, type Coercers, coerce } from './coerce.ts'
export {
  All,
  Body,
  BodyLimit,
  Controller,
  type ControllerOptions,
  Ctx,
  createRouteDecorator,
  Delete,
  Get,
  Head,
  Header,
  Headers,
  HttpCode,
  Options,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  type RouteDecorator,
  type RouteDecoratorArgs,
  UploadedFile,
  UploadedFiles,
  UseGuard,
  UseInterceptor,
  Validate,
} from './decorators.ts'
export {
  BadGatewayException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  GatewayTimeoutException,
  GoneException,
  type HeaderValue,
  type HttpErrorBody,
  HttpException,
  type HttpExceptionOptions,
  InternalServerErrorException,
  isHttpException,
  MethodNotAllowedException,
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  ServiceUnavailableException,
  TooManyRequestsException,
  toIssueDetail,
  UnauthorizedException,
  UnprocessableEntityException,
  UnsupportedMediaTypeException,
  ValidationException,
  type ValidationIssueDetail,
} from './exceptions.ts'
export {
  type ByteRange,
  type ContentDispositionType,
  contentDisposition,
  type FileBody,
  type FileResponseOptions,
  parseRange,
} from './files.ts'
export { contentTypeFor, matchesMediaType } from './mime.ts'
export {
  type ExceptionMapperRef,
  type GuardRef,
  HttpPlugin,
  type HttpPluginOptions,
  type HttpRouteSummary,
  type InterceptorRef,
  type TrailingSlashPolicy,
} from './plugin.ts'
export { parseQuery, type QueryRecord } from './query.ts'
export {
  HttpResponse,
  type HttpResponseInit,
  isHttpResponse,
  type RedirectStatus,
  type StreamResponseOptions,
} from './response.ts'
export { formatByteSize, parseByteSize } from './size.ts'
export {
  type InferSchemaInput,
  type InferSchemaOutput,
  isStandardSchema,
  type StandardSchemaV1,
  type StandardSchemaV1FailureResult,
  type StandardSchemaV1Issue,
  type StandardSchemaV1Options,
  type StandardSchemaV1PathSegment,
  type StandardSchemaV1Props,
  type StandardSchemaV1Result,
  type StandardSchemaV1SuccessResult,
  type StandardSchemaV1Types,
} from './standard-schema.ts'
export { isValidStatus, statusText } from './status.ts'
export { HttpTokens } from './tokens.ts'
export {
  type UploadedFileOptions,
  type UploadedFilesOptions,
  type UploadLimits,
  type Uploads,
  uploads,
} from './uploads.ts'
export { validate } from './validate.ts'

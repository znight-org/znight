/**
 * OpenTelemetry semantic convention attribute names used by the instrumentation (stable HTTP
 * conventions, messaging and code conventions). Declared here to avoid a runtime dependency on
 * `@opentelemetry/semantic-conventions`.
 */
export const SemanticAttributes = {
  HTTP_REQUEST_METHOD: 'http.request.method',
  HTTP_REQUEST_METHOD_ORIGINAL: 'http.request.method_original',
  HTTP_RESPONSE_STATUS_CODE: 'http.response.status_code',
  HTTP_ROUTE: 'http.route',
  URL_PATH: 'url.path',
  URL_SCHEME: 'url.scheme',
  SERVER_ADDRESS: 'server.address',
  SERVER_PORT: 'server.port',
  CLIENT_ADDRESS: 'client.address',
  USER_AGENT_ORIGINAL: 'user_agent.original',
  ERROR_TYPE: 'error.type',
  MESSAGING_SYSTEM: 'messaging.system',
  MESSAGING_OPERATION_NAME: 'messaging.operation.name',
  MESSAGING_OPERATION_TYPE: 'messaging.operation.type',
  MESSAGING_DESTINATION_NAME: 'messaging.destination.name',
  MESSAGING_MESSAGE_ID: 'messaging.message.id',
  CODE_FUNCTION_NAME: 'code.function.name',
  /** Znight specific: request id of the HTTP request. */
  ZNIGHT_REQUEST_ID: 'znight.request.id',
  /** Znight specific: consumer class and handler method of a message. */
  ZNIGHT_CONSUMER: 'znight.messaging.consumer',
  ZNIGHT_HANDLER: 'znight.messaging.handler',
  /** Znight specific: message type, delivery attempt and outcome. */
  ZNIGHT_MESSAGE_TYPE: 'znight.messaging.message.type',
  ZNIGHT_ATTEMPT: 'znight.messaging.message.attempt',
  ZNIGHT_OUTCOME: 'znight.messaging.outcome',
} as const

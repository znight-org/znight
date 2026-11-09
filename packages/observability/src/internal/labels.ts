/**
 * Longest value recorded from a name chosen outside the application code (GraphQL operation names,
 * message types): longer ones become `_OTHER` in metric labels and are truncated in span attributes.
 * Each label value is repeated on every exposition line of its series, so its length is bounded too.
 */
export const MAX_LABEL_LENGTH = 128

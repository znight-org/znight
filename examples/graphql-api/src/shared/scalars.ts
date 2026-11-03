import { scalar } from '@znight/graphql'

/** An e-mail address, lower-cased: a branded string, so that a plain string is not one by accident. */
export type EmailAddress = string & { readonly __brand: 'EmailAddress' }

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

/**
 * Maps `EmailAddress` to the GraphQL scalar `EmailAddress` wherever the type appears (`Viewer.email`,
 * `Review.reviewer`, `NewReviewInput.reviewer`). The compiler reads the name and the type argument;
 * the generated module imports this exported constant.
 *
 * An invalid address in a variable or a literal is a request error (`BAD_USER_INPUT`, or
 * `GRAPHQL_VALIDATION_FAILED` for a literal): the resolver never runs.
 */
export const EmailAddressScalar = scalar<EmailAddress>('EmailAddress', {
  description: 'An e-mail address, lower-cased.',
  specifiedByURL: 'https://html.spec.whatwg.org/multipage/input.html#valid-e-mail-address',
  serialize: value => value,
  parseValue: value => {
    if (typeof value !== 'string' || value.length > 254 || !EMAIL.test(value)) {
      throw new TypeError('Expected an e-mail address')
    }
    return value.toLowerCase() as EmailAddress
  },
})

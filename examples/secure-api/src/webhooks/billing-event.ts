import { z } from 'zod'

/** A delivery of the billing provider, validated once its signature has been checked. */
export const BillingEvent = z.object({
  id: z.string().min(1).max(100),
  type: z.enum(['subscription.created', 'subscription.renewed', 'subscription.cancelled']),
  data: z.object({ customerId: z.string().min(1).max(100), plan: z.string().min(1).max(100) }),
})
export type BillingEvent = z.output<typeof BillingEvent>

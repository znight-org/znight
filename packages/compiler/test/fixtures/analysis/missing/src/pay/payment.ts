import { Injectable } from '@znight/core'

export interface PaymentGateway {
  pay(amount: number): void
}

@Injectable()
export class StripePaymentGateway {
  pay(_amount: number): void {}
}

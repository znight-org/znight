import { Injectable } from '@znight/core'

export class EmailService {}

@Injectable()
export class NotificationService {
  constructor(private readonly email: EmailService) {}
}

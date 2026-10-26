export interface Notifier {
  notify(message: string): void
}

export class SmsNotifier implements Notifier {
  notify(_message: string): void {}
}

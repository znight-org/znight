import type { EmailTemplate, SendEmailJob } from './email.jobs.js'

import { Injectable } from '@znight/core'
import { NonRetryableError } from '@znight/messaging'

/** Subject and body of an email. */
export interface RenderedEmail {
  readonly subject: string
  readonly text: string
}

type Locale = SendEmailJob['locale']

interface TemplateDefinition {
  /** Variables the template needs: a job without them can never succeed. */
  readonly required: readonly string[]
  readonly render: Readonly<Record<Locale, (data: Readonly<Record<string, string>>) => RenderedEmail>>
}

const TEMPLATES: Readonly<Record<EmailTemplate, TemplateDefinition>> = {
  welcome: {
    required: ['name'],
    render: {
      en: ({ name }) => ({ subject: `Welcome, ${name}!`, text: `Hi ${name},\n\nYour account is ready.` }),
      fr: ({ name }) => ({ subject: `Bienvenue, ${name} !`, text: `Bonjour ${name},\n\nVotre compte est prêt.` }),
    },
  },
  'password-reset': {
    required: ['resetUrl'],
    render: {
      en: ({ resetUrl }) => ({ subject: 'Reset your password', text: `Follow this link: ${resetUrl}` }),
      fr: ({ resetUrl }) => ({ subject: 'Réinitialisez votre mot de passe', text: `Suivez ce lien : ${resetUrl}` }),
    },
  },
  'report-ready': {
    required: ['reportId', 'location'],
    render: {
      en: ({ reportId, location }) => ({ subject: `Report ${reportId} is ready`, text: `Download: ${location}` }),
      fr: ({ reportId, location }) => ({
        subject: `Le rapport ${reportId} est prêt`,
        text: `Téléchargement : ${location}`,
      }),
    },
  },
}

/** Renders the email templates. Pure and synchronous: a singleton without dependencies. */
@Injectable()
export class EmailRenderer {
  /** @throws NonRetryableError when a required variable is missing: retrying would fail the same way. */
  render(job: SendEmailJob): RenderedEmail {
    const template = TEMPLATES[job.template]
    const missing = template.required.filter(name => job.data[name] === undefined)
    if (missing.length > 0) {
      throw new NonRetryableError(`Template "${job.template}" needs ${missing.map(name => `data.${name}`).join(', ')}`)
    }
    return template.render[job.locale](job.data)
  }
}

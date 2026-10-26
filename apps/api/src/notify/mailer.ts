import { AppError } from '../errors.js';

export interface Mail { to: string; subject: string; text: string; html: string }

/** Sends one email. The real one uses Resend's HTTP API; tests use a stand-in that records messages. */
export interface Mailer {
  send(mail: Mail): Promise<void>;
}

export function createResend(apiKey: string, from: string, fetchImpl: typeof fetch = fetch, base = 'https://api.resend.com'): Mailer {
  return {
    async send(mail) {
      let res: Response;
      try {
        res = await fetchImpl(`${base}/emails`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from, to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch {
        throw new AppError(502, 'mail_unreachable', 'The email service could not be reached');
      }
      if (!res.ok) throw new AppError(502, 'mail_rejected', `The email service refused the message (${res.status})`);
    },
  };
}

/** The mailer the environment asks for, or undefined when email is not set up (nothing is sent, nothing fails). */
export function mailerFromConfig(config: { RESEND_API_KEY?: string; MAIL_FROM?: string }): Mailer | undefined {
  return config.RESEND_API_KEY && config.MAIL_FROM ? createResend(config.RESEND_API_KEY, config.MAIL_FROM) : undefined;
}

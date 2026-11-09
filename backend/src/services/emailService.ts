import { Resend } from 'resend';
import { getEmailConfig } from '../config/email';

/** A single outbound message. */
export interface OutboundEmail {
  /** Recipient address. */
  to: string;
  /** Address the reply goes to. Usually the original sender. */
  replyTo: string;
  subject: string;
  text: string;
}

/** Thrown when the provider rejects or fails to deliver a message. */
export class EmailDeliveryError extends Error {
  readonly providerMessage: string;

  constructor(providerMessage: string) {
    super('Email delivery failed.');
    this.name = 'EmailDeliveryError';
    this.providerMessage = providerMessage;
  }
}

/**
 * Sends an email through Resend.
 *
 * The provider is contacted here, never from a route handler, so the
 * side effect stays inside the service layer.
 */
export async function sendEmail(message: OutboundEmail): Promise<void> {
  const config = getEmailConfig();
  const resend = new Resend(config.apiKey);

  const { error } = await resend.emails.send({
    from: `${config.fromName} <${config.fromEmail}>`,
    to: message.to,
    replyTo: message.replyTo,
    subject: message.subject,
    text: message.text,
  });

  if (error) {
    throw new EmailDeliveryError(error.message);
  }
}

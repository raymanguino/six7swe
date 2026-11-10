import { FastifyRequest, FastifyReply } from 'fastify';
import { getPortfolioData } from '../../services/portfolioService';
import { EmailDeliveryError, sendEmail } from '../../services/emailService';
import { EmailConfigError } from '../../config/email';

const INPUT_LIMITS = {
  name: 100,
  email: 254,
  company: 200,
  message: 5000,
} as const;

// Simple email regex for basic validation
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function sanitizeString(value: unknown, maxLen: number): string {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

export async function contactHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const body = request.body as Record<string, unknown>;
    const rawName = body.name;
    const rawEmail = body.email;
    const rawCompany = body.company;
    const rawMessage = body.message;

    const name = sanitizeString(rawName, INPUT_LIMITS.name);
    const email = sanitizeString(rawEmail, INPUT_LIMITS.email);
    const company = sanitizeString(rawCompany, INPUT_LIMITS.company);
    const message = sanitizeString(rawMessage, INPUT_LIMITS.message);

    if (!name) {
      return reply.code(400).send({ error: 'Name is required' });
    }
    if (!email) {
      return reply.code(400).send({ error: 'Email is required' });
    }
    if (!message) {
      return reply.code(400).send({ error: 'Message is required' });
    }
    if (!EMAIL_REGEX.test(email)) {
      return reply.code(400).send({ error: 'Invalid email format' });
    }

    const { profile } = await getPortfolioData();
    const recipientEmail = profile?.email;
    if (!recipientEmail) {
      request.log.error('Portfolio profile not found - no recipient email configured');
      return reply.code(500).send({ error: 'Failed to process contact form' });
    }

    const subject = `Contact form: ${name}`;
    const bodyText = [
      `From: ${name} <${email}>`,
      company ? `Company: ${company}` : null,
      '',
      message,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await sendEmail({
        to: recipientEmail,
        replyTo: email,
        subject,
        text: bodyText,
      });
    } catch (error) {
      if (error instanceof EmailConfigError) {
        request.log.error({ error: error.message }, 'Email is not configured');
        return reply.code(500).send({ error: 'Failed to process contact form' });
      }
      if (error instanceof EmailDeliveryError) {
        request.log.error({ error: error.providerMessage }, 'Resend email failed');
        return reply.code(500).send({ error: 'Failed to send message. Please try again later.' });
      }
      throw error;
    }

    request.log.info({ name, email }, 'Contact form submission sent');
    return reply.code(200).send({
      success: true,
      message: 'Your message has been received. Thank you for reaching out!',
    });
  } catch (error) {
    request.log.error(error, 'Error in contact handler');
    return reply.code(500).send({ error: 'Failed to process contact form' });
  }
}

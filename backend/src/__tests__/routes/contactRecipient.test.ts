import Fastify, { FastifyInstance } from 'fastify';
import { getContactRecipient } from '../../config/email';
import { contactHandler } from '../../routes/handlers/contactHandlers';
import { sendEmail } from '../../services/emailService';

jest.mock('../../services/emailService', () => ({
  ...jest.requireActual('../../services/emailService'),
  sendEmail: jest.fn(),
}));

const mockedSendEmail = jest.mocked(sendEmail);

const submission = { name: 'Sam', email: 'sam@example.com', message: 'Hello' };

/**
 * The contact form delivers to `CONTACT_TO_EMAIL`. Without a usable address
 * the form is unavailable: it answers 503 and sends nothing.
 */
describe('contact form recipient', () => {
  const savedRecipient = process.env.CONTACT_TO_EMAIL;
  let app: FastifyInstance;

  beforeEach(async () => {
    mockedSendEmail.mockReset();
    app = Fastify();
    app.post('/contact', contactHandler);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    if (savedRecipient === undefined) delete process.env.CONTACT_TO_EMAIL;
    else process.env.CONTACT_TO_EMAIL = savedRecipient;
  });

  it('answers 503 without sending when no recipient is configured', async () => {
    delete process.env.CONTACT_TO_EMAIL;
    const res = await app.inject({ method: 'POST', url: '/contact', payload: submission });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'The contact form is not available right now' });
    expect(mockedSendEmail).not.toHaveBeenCalled();
  });

  it('sends to CONTACT_TO_EMAIL when there is one', async () => {
    process.env.CONTACT_TO_EMAIL = 'ray@example.com';
    mockedSendEmail.mockResolvedValue(undefined);
    const res = await app.inject({ method: 'POST', url: '/contact', payload: submission });
    expect(res.statusCode).toBe(200);
    expect(mockedSendEmail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ray@example.com', replyTo: 'sam@example.com' }),
    );
  });

  it('treats a value that is not an email address as unset', () => {
    expect(getContactRecipient({ CONTACT_TO_EMAIL: ' ray@example.com ' })).toBe('ray@example.com');
    expect(getContactRecipient({ CONTACT_TO_EMAIL: 'not-an-email' })).toBeNull();
    expect(getContactRecipient({ CONTACT_TO_EMAIL: '' })).toBeNull();
    expect(getContactRecipient({})).toBeNull();
  });
});

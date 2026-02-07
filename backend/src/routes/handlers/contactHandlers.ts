import { FastifyRequest, FastifyReply } from 'fastify';

export async function contactHandler(request: FastifyRequest, reply: FastifyReply) {
  try {
    const { name, email, company, message } = request.body as {
      name?: string;
      email?: string;
      company?: string;
      message?: string;
    };

    if (!name || !email || !message) {
      return reply.code(400).send({ error: 'Name, email, and message are required' });
    }

    // TODO: Implement actual email sending or message storage
    // For now, just log the message
    request.log.info({
      name,
      email,
      company,
      message,
    }, 'Contact form submission');

    // In production, you would:
    // 1. Send an email notification
    // 2. Store the message in a database
    // 3. Send a confirmation email to the sender

    return reply.code(200).send({ 
      success: true,
      message: 'Your message has been received. Thank you for reaching out!' 
    });
  } catch (error) {
    request.log.error(error, 'Error in contact handler');
    return reply.code(500).send({ error: 'Failed to process contact form' });
  }
}

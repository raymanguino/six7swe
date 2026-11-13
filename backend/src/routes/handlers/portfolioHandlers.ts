import { FastifyRequest, FastifyReply } from 'fastify';
import { getPortfolioData } from '../../services/portfolioService';
import { isResumeAvailable } from '../../services/resumeService';

export async function getPortfolioHandler(_request: FastifyRequest, reply: FastifyReply) {
  try {
    const { profile } = await getPortfolioData();
    if (!profile) {
      return reply.code(404).send({ error: 'Portfolio profile not found' });
    }
    return reply.code(200).send({
      name: profile.name,
      title: profile.title,
      email: profile.email,
      phone: profile.phone,
      location: profile.location,
      linkedinUrl: profile.linkedinUrl,
      githubUrl: profile.githubUrl,
      resumeFilename: profile.resumeFilename,
      // The site hides its download link when this is false, rather than link to a 404.
      resumeAvailable: isResumeAvailable(profile.resumeFilename),
    });
  } catch (error) {
    _request.log.error(error, 'Error fetching portfolio');
    return reply.code(500).send({ error: 'Failed to fetch portfolio' });
  }
}

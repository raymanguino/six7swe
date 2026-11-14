import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import {
  getDefaultJobKnowledgeSource,
  type JobKnowledgeSource,
} from '../services/jobHunt/knowledgeSource';

declare module 'fastify' {
  interface FastifyInstance {
    /** The owner's background for job matching; null when the knowledge service is not configured. */
    jobKnowledge: JobKnowledgeSource | null;
  }
}

async function jobKnowledgePlugin(fastify: FastifyInstance) {
  fastify.decorate('jobKnowledge', getDefaultJobKnowledgeSource());
}

export default fp(jobKnowledgePlugin, { name: 'jobKnowledge' });

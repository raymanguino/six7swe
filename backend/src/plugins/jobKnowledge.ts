import fp from 'fastify-plugin';
import { FastifyInstance } from 'fastify';
import {
  getDefaultJobKnowledgeAccess,
  type JobKnowledgeAccess,
} from '../services/jobHunt/knowledgeSource';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * The owner's background for job matching, and who the owner is. Only
     * the owner's profiles are scored against it (`knowledgeForAuthId`).
     */
    jobKnowledge: JobKnowledgeAccess;
  }
}

async function jobKnowledgePlugin(fastify: FastifyInstance) {
  fastify.decorate('jobKnowledge', getDefaultJobKnowledgeAccess());
}

export default fp(jobKnowledgePlugin, { name: 'jobKnowledge' });

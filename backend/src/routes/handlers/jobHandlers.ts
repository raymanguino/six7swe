import { FastifyRequest, FastifyReply, FastifyInstance } from 'fastify';
import { SixSevenService } from '../service'

export async function getAllJobs(request: FastifyRequest, reply: FastifyReply) {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;

  try {
    client = await server.pg.connect();

    const jobs = await server.jobService.getAllJobs(client);

    reply.code(200).send({ jobs }); 
  } catch (error) {
    server.log.error(error, 'Error calling getAllJobs():');
    reply.code(500);
  } finally {
    if (client) {
      client.release();
    }
  }
}

export async function getJobBySourceId(request: FastifyRequest, reply: FastifyReply) {
  const server = request.server as FastifyInstance & SixSevenService;
  let client;

  try {
    const { source_id, source_job_id } = request.params as { source_id: string, source_job_id: string };

    if (!source_id || !source_job_id) {
      reply.code(400).send({ error: 'Invalid or missing source_id or source_job_id' });
      return;
    }

    let sourceId = source_id.trim().toLowerCase();
    let sourceJobId = source_job_id.trim().toLowerCase();
    
    if (['linkedin', 'li'].includes(sourceId)) {
      sourceId = 'LINKEDIN';
    } else {
      reply.code(400).send({ error: 'Unsupported source_id' });
      return;
    }

    client = await server.pg.connect();

    const job = await server.jobService.getJobBySourceId(client, sourceId, sourceJobId);
    if (!job) {
      reply.code(404).send({ error: 'Job not found' });
      return;
    }

    return reply.code(200).send({ job });
  } catch (error) {
    server.log.error(error, 'Error calling getJobById():');
    reply.code(500);
  } finally {
    if (client) {
      client.release();
    }
  }
}

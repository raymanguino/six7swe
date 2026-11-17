import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  PublishRequestSchema,
  SaveDraftRequestSchema,
  type DraftAcceptedResponse,
  type ProfileResponse,
  type ProfileStateResponse,
  type PublishedProfileResponse,
} from '../../contract.js';
import { requireOwner } from '../../plugins/serviceAuth.js';
import {
  getPrimaryResumePdf,
  getPublishedView,
  saveOwnerDraft,
} from '../../services/profile/profiles.js';
import type { KnowledgeContext } from '../context.js';
import { toPrimaryResumeDto, toProfileDto } from '../mappers.js';

export function profileHandlers(ctx: KnowledgeContext) {
  return {
    /** Owner: the draft, the published profile and the drafting status, for review. */
    async state(req: FastifyRequest): Promise<ProfileStateResponse> {
      const ownerId = requireOwner(req);
      const { draft, published } = await ctx.profiles.getProfiles(ownerId);
      return {
        draft: draft && toProfileDto(draft),
        published: published && toProfileDto(published),
        drafting: ctx.drafting.status(ownerId),
      };
    },

    /** Owner: replaces the draft with the owner's edits. */
    async saveDraft(req: FastifyRequest): Promise<ProfileResponse> {
      const ownerId = requireOwner(req);
      const { data } = SaveDraftRequestSchema.parse(req.body);
      return { profile: toProfileDto(await saveOwnerDraft(ctx, ownerId, data)) };
    },

    /** Owner: drafts again from the primary resume, in the background (202). */
    async redraft(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const body: DraftAcceptedResponse = { drafting: ctx.drafting.request(ownerId) };
      return reply.code(202).send(body);
    },

    async discardDraft(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      if (!(await ctx.profiles.deleteDraft(ownerId))) {
        return reply.code(404).send({ error: 'There is no draft' });
      }
      return reply.code(204).send();
    },

    /** Owner: publishes the draft the owner reviewed; 409 if it has changed since. */
    async publish(req: FastifyRequest, reply: FastifyReply) {
      const ownerId = requireOwner(req);
      const { draftVersion } = PublishRequestSchema.parse(req.body);
      const outcome = await ctx.profiles.publishDraft(ownerId, draftVersion);
      switch (outcome.status) {
        case 'no-draft':
          return reply.code(404).send({ error: 'There is no draft to publish' });
        case 'stale':
          return reply.code(409).send({
            error: 'The draft has changed since you reviewed it. Review it again, then publish.',
          });
        case 'published': {
          const body: ProfileResponse = { profile: toProfileDto(outcome.profile) };
          return reply.send(body);
        }
      }
    },

    /** Service: what the public portfolio shows. */
    async published(req: FastifyRequest): Promise<PublishedProfileResponse> {
      const { profile, resume } = await getPublishedView(ctx, requireOwner(req));
      return {
        profile: profile && toProfileDto(profile),
        resume: resume && toPrimaryResumeDto(resume.document, resume.text),
      };
    },

    /** Service: the primary resume's file, when it is a PDF. */
    async resumePdf(req: FastifyRequest, reply: FastifyReply) {
      const bytes = await getPrimaryResumePdf(ctx, requireOwner(req));
      if (!bytes) return reply.code(404).send({ error: 'No PDF resume' });
      return reply
        .header('content-type', 'application/pdf')
        .header('content-length', bytes.byteLength)
        .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  };
}

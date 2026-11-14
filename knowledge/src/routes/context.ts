import type { EvalRepository } from '../db/api/evalRepository.js';
import type { ProfileRepository } from '../db/api/profileRepository.js';
import type { KnowledgeDeps } from '../services/deps.js';
import type { EvalSet } from '../services/evalSet/evalSet.js';
import type { EvalRunner } from '../services/evalSet/runner.js';
import type { IngestionQueue } from '../services/ingestion/pipeline.js';
import type { ProfileDrafting } from '../services/profile/profiles.js';

/**
 * What the route handlers need. Built once in `buildApp` and passed down.
 * The owner is per request (`requireOwner(req)`), not part of the context.
 */
export interface KnowledgeContext extends KnowledgeDeps {
  queue: IngestionQueue;
  profiles: ProfileRepository;
  drafting: ProfileDrafting;
  /** The evolving chat eval set (#85). */
  evalRepo: EvalRepository;
  evalSet: EvalSet;
  evalRunner: EvalRunner;
}

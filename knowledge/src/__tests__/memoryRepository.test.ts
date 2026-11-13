import { randomUUID } from 'node:crypto';
import { createMemoryRepository } from './support/memoryRepository.js';
import { describeRepositoryContract } from './support/repositoryContract.js';

// One repository for the whole run, like the shared database: tests stay
// independent through fresh owner ids, not through fresh repositories.
const repo = createMemoryRepository();

describeRepositoryContract('memory', () => ({
  repo,
  newOwner: () => `owner-${randomUUID()}`,
}));

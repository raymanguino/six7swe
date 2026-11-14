import { randomUUID } from 'node:crypto';
import { describeEvalRepositoryContract } from './support/evalRepositoryContract.js';
import { createMemoryEvalRepository } from './support/memoryEvalRepository.js';
import { createMemoryProfileRepository } from './support/memoryProfileRepository.js';
import { createMemoryRepository } from './support/memoryRepository.js';
import { describeProfileRepositoryContract } from './support/profileRepositoryContract.js';
import { describeRepositoryContract } from './support/repositoryContract.js';

// One repository for the whole run, like the shared database: tests stay
// independent through fresh owner ids, not through fresh repositories.
const repo = createMemoryRepository();
const profiles = createMemoryProfileRepository();
const evalRepo = createMemoryEvalRepository();

describeRepositoryContract('memory', () => ({
  repo,
  newOwner: () => `owner-${randomUUID()}`,
}));

describeProfileRepositoryContract('memory', () => ({
  profiles,
  newOwner: () => `owner-${randomUUID()}`,
}));

describeEvalRepositoryContract('memory', () => ({
  evalRepo,
  newOwner: () => `owner-${randomUUID()}`,
}));

import { randomUUID } from 'node:crypto';
import { describeEvalRepositoryContract } from './support/evalRepositoryContract.js';
import { createMemoryEvalRepository } from './support/memoryEvalRepository.js';
import { createMemoryRepository } from './support/memoryRepository.js';
import { describeRepositoryContract } from './support/repositoryContract.js';

// One repository for the whole run, like the shared database: tests stay
// independent through fresh owner ids, not through fresh repositories.
const repo = createMemoryRepository();
const evalRepo = createMemoryEvalRepository();

describeRepositoryContract('memory', () => ({
  repo,
  newOwner: () => `owner-${randomUUID()}`,
  async forgetScan(id) {
    const doc = repo.documents.get(id);
    if (doc) repo.documents.set(id, { ...doc, scannedAt: null, findingCount: 0 });
    repo.findings.delete(id);
  },
}));

describeEvalRepositoryContract('memory', () => ({
  evalRepo,
  newOwner: () => `owner-${randomUUID()}`,
}));

import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../app.js';
import { loadEnv } from '../config/env.js';
import {
  DraftAcceptedResponseSchema,
  PROFILE_LIMITS,
  ProfileResponseSchema,
  ProfileStateResponseSchema,
  PublishedProfileResponseSchema,
  type ProfileData,
} from '../contract.js';
import { createHashingEmbedder } from '../services/embedding/hashing.js';
import { ingestDocument } from '../services/ingestion/pipeline.js';
import {
  createMiniMaxProfileDrafter,
  MINIMAX_MAX_COMPLETION_TOKENS,
  stripThinking,
  createProfileDrafter,
  createStubProfileDrafter,
  DraftError,
  parseModelJson,
  type ProfileDrafter,
} from '../services/profile/drafter.js';
import { normalizeProfileDraft } from '../services/profile/normalize.js';
import { createProfileDrafting, DRAFT_KEPT_EDITS } from '../services/profile/profiles.js';
import {
  createMemoryFileStore,
  makePdf,
  multipartFile,
  PROJECT_NOTES_TXT,
  RESUME_MD,
  SAMPLE_PROFILE,
  silentLogger,
  utf8,
} from './support/fixtures.js';
import { createMemoryProfileRepository } from './support/memoryProfileRepository.js';
import { createMemoryRepository } from './support/memoryRepository.js';

const KEY = 'k'.repeat(40);
const OWNER_KEY = 'o'.repeat(40);
const serviceAuth = { 'x-knowledge-key': KEY };
const ownerAuth = { 'x-knowledge-key': OWNER_KEY };

/** A deterministic stand-in for the model: it names the profile after the resume's first line. */
function fakeDrafter(overrides: Partial<ProfileData> = {}): ProfileDrafter & { calls: string[] } {
  const calls: string[] = [];
  return {
    name: 'fake',
    calls,
    async draft(text) {
      calls.push(text);
      const firstLine = text.split('\n')[0]?.replace(/^#\s*/, '') ?? 'Unknown';
      return { ...SAMPLE_PROFILE, name: firstLine, ...overrides };
    },
  };
}

let app: FastifyInstance | undefined;

afterEach(async () => {
  if (!app) return;
  await app.ingestionQueue.idle();
  await app.profileDrafting.idle();
  await app.close();
  app = undefined;
});

async function start(drafter: ProfileDrafter | null) {
  const files = createMemoryFileStore();
  const built = await buildApp({
    deps: { repo: createMemoryRepository(), files, embedder: createHashingEmbedder(256) },
    profile: { repo: createMemoryProfileRepository(), drafter },
    serviceKey: KEY,
    ownerKey: OWNER_KEY,
    ownerId: 'owner',
    maxUploadBytes: 4096,
    logger: false,
  });
  app = built;
  const settle = async () => {
    await built.ingestionQueue.idle();
    await built.profileDrafting.idle();
  };
  const upload = async (name: string, bytes: Uint8Array, kind: 'resume' | 'supporting') => {
    const { payload, headers } = multipartFile(name, bytes);
    const res = await built.inject({
      method: 'POST',
      url: `/documents?kind=${kind}`,
      payload,
      headers: { ...headers, ...ownerAuth },
    });
    expect(res.statusCode).toBe(202);
    await settle();
    return res.json<{ document: { id: string } }>().document;
  };
  const state = async () => {
    const res = await built.inject({ method: 'GET', url: '/profile', headers: ownerAuth });
    expect(res.statusCode).toBe(200);
    return ProfileStateResponseSchema.parse(res.json());
  };
  return { app: built, files, settle, upload, state };
}

describe('profile drafting on upload', () => {
  it('drafts a profile when a resume is uploaded, and not for a supporting document', async () => {
    const drafter = fakeDrafter();
    const { upload, state } = await start(drafter);

    await upload('notes.txt', utf8(PROJECT_NOTES_TXT), 'supporting');
    expect(drafter.calls).toHaveLength(0);
    expect((await state()).draft).toBeNull();

    const resume = await upload('resume.md', utf8(RESUME_MD), 'resume');
    expect(drafter.calls).toEqual([RESUME_MD.trim()]);
    const current = await state();
    expect(current.draft).toMatchObject({
      stage: 'draft',
      sourceDocumentId: resume.id,
      data: { name: 'Jordan Example' },
    });
    expect(current.published).toBeNull();
    expect(current.drafting).toEqual({
      enabled: true,
      state: 'idle',
      documentId: resume.id,
      error: null,
    });
  });

  it('records a failed draft with the reason the owner may see', async () => {
    const failing: ProfileDrafter = {
      name: 'failing',
      draft: () =>
        Promise.reject(new DraftError('MiniMax returned an error (status 503).', 'body')),
    };
    const { upload, state } = await start(failing);
    const resume = await upload('resume.md', utf8(RESUME_MD), 'resume');
    expect(await state()).toMatchObject({
      draft: null,
      drafting: {
        state: 'failed',
        documentId: resume.id,
        error: 'MiniMax returned an error (status 503).',
      },
    });
  });

  it('hides unexpected errors behind a generic reason', async () => {
    const crashing: ProfileDrafter = {
      name: 'crashing',
      draft: () => Promise.reject(new Error('secret internals')),
    };
    const { upload, state } = await start(crashing);
    await upload('resume.md', utf8(RESUME_MD), 'resume');
    expect((await state()).drafting).toMatchObject({
      state: 'failed',
      error: 'Drafting failed unexpectedly. Try again.',
    });
  });

  it('never fails an ingest because the post-ingest hook failed', async () => {
    const repo = createMemoryRepository();
    const files = createMemoryFileStore();
    const { document } = await repo.createDocument({
      ownerId: 'owner',
      filename: 'resume.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      sha256: 'a'.repeat(64),
      storagePath: 'owner/a.md',
      kind: 'resume',
    });
    await files.put('owner/a.md', utf8(RESUME_MD), 'text/markdown');
    const hook = vi.fn(() => Promise.reject(new Error('boom')));
    await ingestDocument(
      {
        repo,
        files,
        embedder: createHashingEmbedder(256),
        log: silentLogger,
        onResumeIngested: hook,
      },
      document,
    );
    expect(hook).toHaveBeenCalledOnce();
    expect(await repo.getDocument('owner', document.id)).toMatchObject({ status: 'ready' });
  });

  it('redrafts on request, and answers 409 when drafting is off', async () => {
    const drafter = fakeDrafter();
    const { app: a, upload, settle, state } = await start(drafter);
    await upload('resume.md', utf8(RESUME_MD), 'resume');

    const res = await a.inject({ method: 'POST', url: '/profile/draft', headers: ownerAuth });
    expect(res.statusCode).toBe(202);
    expect(DraftAcceptedResponseSchema.parse(res.json()).drafting.state).toBe('drafting');
    await settle();
    expect(drafter.calls).toHaveLength(2);
    expect((await state()).drafting.state).toBe('idle');

    await a.close();
    app = undefined;
    const { app: off, upload: uploadOff, state: stateOff } = await start(null);
    await uploadOff('resume.md', utf8(RESUME_MD), 'resume');
    expect((await stateOff()).drafting).toMatchObject({ enabled: false, state: 'idle' });
    const refused = await off.inject({ method: 'POST', url: '/profile/draft', headers: ownerAuth });
    expect(refused.statusCode).toBe(409);
  });

  it('fails a requested draft when there is no resume', async () => {
    const { app: a, settle, state } = await start(fakeDrafter());
    await a.inject({ method: 'POST', url: '/profile/draft', headers: ownerAuth });
    await settle();
    expect((await state()).drafting).toMatchObject({
      state: 'failed',
      error: 'There is no primary resume to draft from.',
    });
  });
});

describe('review and publish', () => {
  it('edits the draft, refuses a stale publish, then publishes', async () => {
    const { app: a, upload, state } = await start(fakeDrafter());
    const resume = await upload('resume.md', utf8(RESUME_MD), 'resume');
    const drafted = (await state()).draft;
    if (!drafted) throw new Error('expected a draft');

    const edited = { ...drafted.data, title: 'Principal Engineer' };
    const save = await a.inject({
      method: 'PUT',
      url: '/profile/draft',
      headers: ownerAuth,
      payload: { data: edited },
    });
    expect(save.statusCode).toBe(200);
    const saved = ProfileResponseSchema.parse(save.json()).profile;
    // The owner's edits keep the resume the draft came from.
    expect(saved).toMatchObject({
      sourceDocumentId: resume.id,
      data: { title: 'Principal Engineer' },
    });

    const stale = await a.inject({
      method: 'POST',
      url: '/profile/publish',
      headers: ownerAuth,
      payload: { draftUpdatedAt: drafted.updatedAt },
    });
    expect(stale.statusCode).toBe(409);

    const publish = await a.inject({
      method: 'POST',
      url: '/profile/publish',
      headers: ownerAuth,
      payload: { draftUpdatedAt: saved.updatedAt },
    });
    expect(publish.statusCode).toBe(200);
    expect(await state()).toMatchObject({
      draft: null,
      published: { stage: 'published', data: { title: 'Principal Engineer' } },
    });

    const again = await a.inject({
      method: 'POST',
      url: '/profile/publish',
      headers: ownerAuth,
      payload: { draftUpdatedAt: saved.updatedAt },
    });
    expect(again.statusCode).toBe(404);
  });

  it('validates edits against the contract', async () => {
    const { app: a } = await start(null);
    const res = await a.inject({
      method: 'PUT',
      url: '/profile/draft',
      headers: ownerAuth,
      payload: {
        data: {
          ...SAMPLE_PROFILE,
          links: { ...SAMPLE_PROFILE.links, github: 'javascript:alert(1)' },
        },
      },
    });
    expect(res.statusCode).toBe(400);
  });

  it('discards the draft', async () => {
    const { app: a, state } = await start(null);
    await a.inject({
      method: 'PUT',
      url: '/profile/draft',
      headers: ownerAuth,
      payload: { data: SAMPLE_PROFILE },
    });
    const del = await a.inject({ method: 'DELETE', url: '/profile/draft', headers: ownerAuth });
    expect(del.statusCode).toBe(204);
    expect((await state()).draft).toBeNull();
    const none = await a.inject({ method: 'DELETE', url: '/profile/draft', headers: ownerAuth });
    expect(none.statusCode).toBe(404);
  });
});

describe('public profile and resume (service routes)', () => {
  it('keeps owner and service credentials apart', async () => {
    const { app: a } = await start(null);
    const status = async (url: string, headers: Record<string, string>) =>
      (await a.inject({ method: 'GET', url, headers })).statusCode;
    expect(await status('/profile/published', ownerAuth)).toBe(401);
    expect(await status('/resume.pdf', ownerAuth)).toBe(401);
    expect(await status('/profile', serviceAuth)).toBe(401);
    expect(await status('/profile/published', serviceAuth)).toBe(200);
  });

  it('serves the published profile and the primary resume', async () => {
    const { app: a, upload } = await start(null);
    const empty = await a.inject({
      method: 'GET',
      url: '/profile/published',
      headers: serviceAuth,
    });
    expect(PublishedProfileResponseSchema.parse(empty.json())).toEqual({
      profile: null,
      resume: null,
    });

    const pdf = makePdf(['Jordan Example', 'Senior software engineer']);
    const resume = await upload('jordan.pdf', pdf, 'resume');
    const save = await a.inject({
      method: 'PUT',
      url: '/profile/draft',
      headers: ownerAuth,
      payload: { data: SAMPLE_PROFILE },
    });
    const { updatedAt } = ProfileResponseSchema.parse(save.json()).profile;
    await a.inject({
      method: 'POST',
      url: '/profile/publish',
      headers: ownerAuth,
      payload: { draftUpdatedAt: updatedAt },
    });

    const res = await a.inject({ method: 'GET', url: '/profile/published', headers: serviceAuth });
    const body = PublishedProfileResponseSchema.parse(res.json());
    expect(body.profile?.data).toEqual(SAMPLE_PROFILE);
    expect(body.resume).toMatchObject({
      documentId: resume.id,
      filename: 'jordan.pdf',
      isPdf: true,
    });
    expect(body.resume?.text).toContain('Jordan Example');

    const file = await a.inject({ method: 'GET', url: '/resume.pdf', headers: serviceAuth });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('application/pdf');
    expect(new Uint8Array(file.rawPayload)).toEqual(pdf);
  });

  it('answers 404 for /resume.pdf when the primary resume is not a PDF', async () => {
    const { app: a, upload } = await start(null);
    expect(
      (await a.inject({ method: 'GET', url: '/resume.pdf', headers: serviceAuth })).statusCode,
    ).toBe(404);
    await upload('resume.md', utf8(RESUME_MD), 'resume');
    expect(
      (await a.inject({ method: 'GET', url: '/resume.pdf', headers: serviceAuth })).statusCode,
    ).toBe(404);
  });
});

describe('normalizeProfileDraft', () => {
  it('fixes the slips models make and drops unsafe links', () => {
    const profile = normalizeProfileDraft({
      name: ' Jordan Example ',
      title: 'Engineer',
      location: '',
      summary: 'Builds things.',
      skills: ['TypeScript', '', 'TypeScript', 'Go'],
      experience: [
        { title: 'Engineer', company: 'Acme', period: 2021, description: 'Did work.' },
        { title: '', company: 'No title', period: '', description: '' },
      ],
      links: {
        email: 'mailto:jordan@example.com',
        phone: '',
        linkedin: 'linkedin.com/in/jordan',
        github: 'javascript:alert(1)',
        website: 'not a url at all',
      },
    });
    expect(profile).toEqual({
      name: 'Jordan Example',
      title: 'Engineer',
      location: null,
      summary: 'Builds things.',
      skills: ['TypeScript', 'Go'],
      experience: [
        { title: 'Engineer', company: 'Acme', period: '2021', description: 'Did work.' },
      ],
      projects: [],
      links: {
        email: 'jordan@example.com',
        phone: null,
        linkedin: 'https://linkedin.com/in/jordan',
        github: null,
        website: null,
      },
    });
  });

  it('rejects a profile without a name', () => {
    expect(() => normalizeProfileDraft({ title: 'Engineer' })).toThrow();
  });

  it('cuts over-long text to its limit instead of rejecting the draft', () => {
    const long = (n: number) => 'x'.repeat(n);
    const profile = normalizeProfileDraft({
      name: long(250),
      title: long(300),
      location: long(201),
      summary: long(5000),
      skills: [long(201)],
      experience: [
        { title: long(201), company: 'Acme', period: long(201), description: long(4001) },
      ],
      projects: [{ name: long(201), description: long(4001), technologies: [long(201)] }],
      links: { phone: '1'.repeat(51) },
    });
    const { shortText, longText } = PROFILE_LIMITS;
    expect(profile.name).toHaveLength(shortText);
    expect(profile.title).toHaveLength(shortText);
    expect(profile.location).toHaveLength(shortText);
    expect(profile.summary).toHaveLength(longText);
    expect(profile.skills[0]).toHaveLength(shortText);
    expect(profile.experience[0]?.title).toHaveLength(shortText);
    expect(profile.experience[0]?.period).toHaveLength(shortText);
    expect(profile.experience[0]?.description).toHaveLength(longText);
    expect(profile.projects[0]?.name).toHaveLength(shortText);
    expect(profile.projects[0]?.description).toHaveLength(longText);
    expect(profile.projects[0]?.technologies[0]).toHaveLength(shortText);
    // A phone number that long is not one: dropped.
    expect(profile.links.phone).toBeNull();
  });

  it('treats keys the model left out as empty, without dropping the rest', () => {
    const profile = normalizeProfileDraft({
      name: 'Jordan',
      title: 'Engineer',
      links: { github: 'https://github.com/jordan' },
    });
    expect(profile).toMatchObject({
      location: null,
      summary: '',
      skills: [],
      links: { email: null, phone: null, github: 'https://github.com/jordan', website: null },
    });
  });

  it('cuts by UTF-16 code units without splitting an emoji', () => {
    const emoji = (n: number) => '😀'.repeat(n); // two code units each
    const profile = normalizeProfileDraft({
      name: emoji(150),
      title: 'x' + emoji(150), // odd offset: the cut would land mid-pair
      summary: emoji(2500),
    });
    const { shortText, longText } = PROFILE_LIMITS;
    expect(profile.name).toBe(emoji(shortText / 2));
    expect(profile.title).toBe('x' + emoji(shortText / 2 - 1));
    expect(profile.summary).toBe(emoji(longText / 2));
  });
});

describe('drafting races', () => {
  /** A drafter whose calls finish only when the test says so. */
  function gatedDrafter() {
    const gates: Array<(data: ProfileData) => void> = [];
    const drafter: ProfileDrafter = {
      name: 'gated',
      draft: () => new Promise<ProfileData>((resolve) => gates.push(resolve)),
    };
    return { drafter, gates };
  }

  async function setupDrafting(drafter: ProfileDrafter) {
    const repo = createMemoryRepository();
    const profiles = createMemoryProfileRepository();
    const { document } = await repo.createDocument({
      ownerId: 'owner',
      filename: 'resume.md',
      mimeType: 'text/markdown',
      sizeBytes: 10,
      sha256: 'b'.repeat(64),
      storagePath: 'owner/b.md',
      kind: 'resume',
    });
    await repo.completeIngestion(document.id, RESUME_MD, []);
    const drafting = createProfileDrafting({ repo, profiles, drafter, log: silentLogger });
    return { profiles, drafting };
  }

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 1));
    expect(check()).toBe(true);
  };

  it('stays drafting while another draft is queued behind a finished one', async () => {
    const { drafter, gates } = gatedDrafter();
    const { profiles, drafting } = await setupDrafting(drafter);

    drafting.request('owner');
    await until(() => gates.length === 1);
    drafting.request('owner'); // e.g. a newer resume finished meanwhile

    gates[0]?.({ ...SAMPLE_PROFILE, title: 'First' });
    await until(() => gates.length === 2);
    expect(drafting.status('owner').state).toBe('drafting');

    gates[1]?.({ ...SAMPLE_PROFILE, title: 'Second' });
    await drafting.idle();
    expect(drafting.status('owner')).toMatchObject({ state: 'idle', error: null });
    expect((await profiles.getProfiles('owner')).draft?.data.title).toBe('Second');
  });

  it('keeps the owner’s edits saved while the model was drafting', async () => {
    const { drafter, gates } = gatedDrafter();
    const { profiles, drafting } = await setupDrafting(drafter);
    await profiles.saveDraft('owner', SAMPLE_PROFILE, null);

    drafting.request('owner');
    await until(() => gates.length === 1);
    await profiles.saveDraft('owner', { ...SAMPLE_PROFILE, title: 'Owner edit' }, null);

    gates[0]?.({ ...SAMPLE_PROFILE, title: 'Model draft' });
    await drafting.idle();
    expect((await profiles.getProfiles('owner')).draft?.data.title).toBe('Owner edit');
    expect(drafting.status('owner')).toMatchObject({ state: 'failed', error: DRAFT_KEPT_EDITS });
  });
});

describe('MiniMax drafter', () => {
  const URL = 'https://api.minimax.io/v1/chat/completions';

  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const answer = (content: string, finishReason = 'stop') =>
    reply({
      choices: [{ finish_reason: finishReason, message: { content, role: 'assistant' } }],
      base_resp: { status_code: 0, status_msg: 'success' },
    });

  const drafterWith = (fetchImpl: typeof fetch, secondaryApiKey?: string, timeoutMs?: number) =>
    createMiniMaxProfileDrafter({
      url: URL,
      apiKey: 'mm-primary',
      secondaryApiKey,
      model: 'MiniMax-M3',
      fetchImpl,
      timeoutMs,
    });

  /** The DraftError a draft fails with. */
  const failure = async (promise: Promise<unknown>): Promise<DraftError> => {
    try {
      await promise;
    } catch (error) {
      if (error instanceof DraftError) return error;
      throw error;
    }
    throw new Error('expected the draft to fail');
  };

  /** A fetch that never answers on its own, only rejects when the request's signal aborts. */
  const hangingFetch: typeof fetch = (_url, init) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });

  it('sends the resume the way the backend calls MiniMax, and validates the answer', async () => {
    const fetchImpl = vi.fn<typeof fetch>(() =>
      Promise.resolve(answer('```json\n' + JSON.stringify(SAMPLE_PROFILE) + '\n```')),
    );
    const profile = await drafterWith(fetchImpl).draft(RESUME_MD);
    expect(profile).toEqual(SAMPLE_PROFILE);

    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(URL);
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer mm-primary');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown> & {
      messages: Array<{ role: string; content: string }>;
    };
    expect(body).toMatchObject({
      model: 'MiniMax-M3',
      max_completion_tokens: MINIMAX_MAX_COMPLETION_TOKENS,
      reasoning_effort: 'medium',
    });
    expect(body).not.toHaveProperty('response_format');
    expect(body.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(body.messages[1]?.content).toContain('Acme Corp');
  });

  it('strips a leading think block before parsing', async () => {
    const content = `<think>The resume says Acme...</think>\n${JSON.stringify(SAMPLE_PROFILE)}`;
    const profile = await drafterWith(() => Promise.resolve(answer(content))).draft(RESUME_MD);
    expect(profile).toEqual(SAMPLE_PROFILE);
    expect(stripThinking('  <think>a\nb</think> {"a":1}')).toBe('{"a":1}');
  });

  it('reports an error MiniMax returns inside a 200 body', async () => {
    const error = drafterWith(() =>
      Promise.resolve(
        reply({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
      ),
    ).draft('x');
    await expect(error).rejects.toThrow('MiniMax returned an error (code 1008).');
    await expect(error).rejects.toMatchObject({ detail: 'insufficient balance' });
  });

  it('says so when the token limit was hit before an answer', async () => {
    await expect(
      drafterWith(() => Promise.resolve(answer('', 'length'))).draft('x'),
    ).rejects.toThrow('MiniMax hit its token limit before answering.');
    await expect(drafterWith(() => Promise.resolve(answer(''))).draft('x')).rejects.toThrow(
      'MiniMax sent an empty answer.',
    );
  });

  it('retries a 429 once with the secondary key', async () => {
    const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(
        new Headers(init?.headers).get('authorization') === 'Bearer mm-primary'
          ? reply({ error: 'rate limited' }, 429)
          : answer(JSON.stringify(SAMPLE_PROFILE)),
      ),
    );
    expect(await drafterWith(fetchImpl, 'mm-secondary').draft('x')).toEqual(SAMPLE_PROFILE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchImpl.mock.calls[1]?.[1]?.headers).get('authorization')).toBe(
      'Bearer mm-secondary',
    );

    // Without a secondary key, the 429 is the answer.
    const once = vi.fn<typeof fetch>(() => Promise.resolve(reply({}, 429)));
    await expect(drafterWith(once).draft('x')).rejects.toThrow(
      'MiniMax returned an error (status 429).',
    );
    expect(once).toHaveBeenCalledOnce();
  });

  it('turns other failures into fixed, owner-facing messages', async () => {
    await expect(
      drafterWith(() => Promise.resolve(new Response('overloaded', { status: 503 }))).draft('x'),
    ).rejects.toThrow('MiniMax returned an error (status 503).');
    await expect(drafterWith(() => Promise.resolve(answer('not json'))).draft('x')).rejects.toThrow(
      'The model did not answer with JSON.',
    );
    await expect(
      drafterWith(() => Promise.resolve(answer(JSON.stringify({ title: 'x' })))).draft('x'),
    ).rejects.toThrow('did not match the profile format');
    await expect(
      drafterWith(() => Promise.reject(new TypeError('fetch failed'))).draft('x'),
    ).rejects.toThrow('MiniMax could not be reached.');
  });

  it('parses JSON with or without a code fence, or wrapped in prose', () => {
    expect(parseModelJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseModelJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('Here is the profile:\n{"a":{"b":2}}\nHope that helps.')).toEqual({
      a: { b: 2 },
    });
  });

  it('logs only the length of an answer that is not JSON, never its text', async () => {
    const error = await failure(
      drafterWith(() => Promise.resolve(answer('Jordan lives at 1 Main St'))).draft('x'),
    );
    expect(error.message).toBe('The model did not answer with JSON.');
    expect(error.detail).toBe('answer of 25 characters was not JSON');
    expect(error.cause).toBeUndefined();
  });

  it('reports the token limit when reasoning was cut off inside <think>', async () => {
    expect(stripThinking('<think>never closes')).toBe('');
    await expect(
      drafterWith(() => Promise.resolve(answer('<think>never closes', 'length'))).draft('x'),
    ).rejects.toThrow('MiniMax hit its token limit before answering.');
  });

  it('cancels the rate-limited body before retrying', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const limited = reply({ error: 'rate limited' }, 429);
    Object.defineProperty(limited, 'body', { value: { cancel } });
    const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
      Promise.resolve(
        new Headers(init?.headers).get('authorization') === 'Bearer mm-primary'
          ? limited
          : answer(JSON.stringify(SAMPLE_PROFILE)),
      ),
    );
    expect(await drafterWith(fetchImpl, 'mm-secondary').draft('x')).toEqual(SAMPLE_PROFILE);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('reports the secondary key’s failure when it fails too', async () => {
    for (const second of [429, 503]) {
      const fetchImpl = vi.fn<typeof fetch>((_url, init) =>
        Promise.resolve(
          new Headers(init?.headers).get('authorization') === 'Bearer mm-primary'
            ? reply({}, 429)
            : reply({}, second),
        ),
      );
      await expect(drafterWith(fetchImpl, 'mm-secondary').draft('x')).rejects.toThrow(
        `MiniMax returned an error (status ${second}).`,
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    }
  });

  it('says so when a 200 body is not JSON', async () => {
    await expect(
      drafterWith(() => Promise.resolve(new Response('<html>gateway</html>'))).draft('x'),
    ).rejects.toThrow('MiniMax sent a response that was not JSON.');
  });

  it('reports a timeout, whether while connecting or reading the body', async () => {
    await expect(drafterWith(hangingFetch, undefined, 20).draft('x')).rejects.toThrow(
      'MiniMax did not answer in time.',
    );

    // The deadline strikes during res.json().
    const slowBody: typeof fetch = (_url, init) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      } as unknown as Response);
    await expect(drafterWith(slowBody, undefined, 20).draft('x')).rejects.toThrow(
      'MiniMax did not answer in time.',
    );

    // ...or while an error body is read.
    const slowError: typeof fetch = (_url, init) =>
      Promise.resolve({
        ok: false,
        status: 500,
        text: () =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
          }),
      } as unknown as Response);
    await expect(drafterWith(slowError, undefined, 20).draft('x')).rejects.toThrow(
      'MiniMax did not answer in time.',
    );
  });

  it('never puts a key in an error message or detail', async () => {
    const leaky = [
      reply({ error: 'bad key mm-primary', echo: 'Bearer mm-primary-long-token-value' }, 401),
      reply({ base_resp: { status_code: 1004, status_msg: 'invalid key mm-secondary' } }),
    ];
    for (const res of leaky) {
      const error = await failure(
        drafterWith(() => Promise.resolve(res), 'mm-secondary').draft('x'),
      );
      for (const text of [error.message, error.detail ?? '']) {
        expect(text).not.toContain('mm-primary');
        expect(text).not.toContain('mm-secondary');
      }
      expect(error.detail).toContain('[redacted]');
    }
  });
});

describe('createProfileDrafter', () => {
  it('wires the configured drafter', async () => {
    expect(createProfileDrafter({ kind: 'none' })).toBeNull();
    expect(createProfileDrafter({ kind: 'stub' })?.name).toBe('stub');

    const fetchImpl = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          choices: [
            { finish_reason: 'stop', message: { content: JSON.stringify(SAMPLE_PROFILE) } },
          ],
          base_resp: { status_code: 0 },
        }),
      ),
    );
    try {
      const drafter = createProfileDrafter({
        kind: 'minimax',
        url: 'https://api.minimax.io/v1/chat/completions',
        apiKey: 'mm-primary',
        model: 'MiniMax-M3',
      });
      expect(drafter?.name).toBe('minimax:MiniMax-M3');
      expect(await drafter?.draft(RESUME_MD)).toEqual(SAMPLE_PROFILE);
      expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.minimax.io/v1/chat/completions');
    } finally {
      fetchImpl.mockRestore();
    }
  });
});

describe('stub drafter', () => {
  it('drafts deterministically from the resume text', async () => {
    const drafter = createStubProfileDrafter();
    const text = `${RESUME_MD}\nContact: jordan@example.com, https://github.com/jordan-example`;
    const first = await drafter.draft(text);
    expect(first).toMatchObject({
      name: 'Jordan Example',
      title: 'Senior software engineer.',
      links: { email: 'jordan@example.com', github: 'https://github.com/jordan-example' },
    });
    expect(await drafter.draft(text)).toEqual(first);
  });

  it('matches link hosts literally', async () => {
    const drafter = createStubProfileDrafter();
    const lookalike = await drafter.draft('Jordan\nEngineer\nhttps://githubxcom/jordan');
    expect(lookalike.links.github).toBeNull();
  });
});

describe('PROFILE_DRAFTER configuration', () => {
  const base = {
    DATABASE_URL: 'postgres://localhost/db',
    KNOWLEDGE_SERVICE_KEY: 'k'.repeat(32),
    KNOWLEDGE_OWNER_KEY: 'o'.repeat(32),
    OWNER_AUTH_ID: 'owner',
    EMBEDDER: 'hashing',
    FILE_STORE: 'local',
  };

  it('is off by default', () => {
    expect(loadEnv(base).profileDrafter).toEqual({ kind: 'none' });
  });

  it('uses MiniMax with its key and default model, or an override', () => {
    expect(
      loadEnv({ ...base, PROFILE_DRAFTER: 'minimax', MINIMAX_API_KEY: 'mm' }).profileDrafter,
    ).toEqual({
      kind: 'minimax',
      url: 'https://api.minimax.io/v1/chat/completions',
      apiKey: 'mm',
      secondaryApiKey: undefined,
      model: 'MiniMax-M3',
    });
    expect(
      loadEnv({
        ...base,
        PROFILE_DRAFTER: 'minimax',
        MINIMAX_API_KEY: 'mm',
        MINIMAX_API_KEY_SECONDARY: 'mm2',
        PROFILE_DRAFT_MODEL: 'MiniMax-Other',
      }).profileDrafter,
    ).toMatchObject({ secondaryApiKey: 'mm2', model: 'MiniMax-Other' });
  });

  it('requires the MiniMax key, and the embedder is unaffected', () => {
    expect(() => loadEnv({ ...base, PROFILE_DRAFTER: 'minimax' })).toThrow(
      /MINIMAX_API_KEY is required when PROFILE_DRAFTER=minimax/,
    );
    // OpenAI and OpenRouter are embedders only; MiniMax is a drafter only.
    expect(() => loadEnv({ ...base, PROFILE_DRAFTER: 'openai', OPENAI_API_KEY: 'sk' })).toThrow(
      /PROFILE_DRAFTER/,
    );
    expect(() => loadEnv({ ...base, EMBEDDER: 'minimax', MINIMAX_API_KEY: 'mm' })).toThrow(
      /EMBEDDER/,
    );
    const env = loadEnv({
      ...base,
      EMBEDDER: 'openai',
      OPENAI_API_KEY: 'sk',
      PROFILE_DRAFTER: 'minimax',
      MINIMAX_API_KEY: 'mm',
    });
    expect(env.embedder).toMatchObject({ provider: 'openai', apiKey: 'sk' });
  });

  it('refuses the stub in production', () => {
    expect(() =>
      loadEnv({
        ...base,
        NODE_ENV: 'production',
        EMBEDDER: 'openai',
        OPENAI_API_KEY: 'sk',
        PROFILE_DRAFTER: 'stub',
      }),
    ).toThrow(/PROFILE_DRAFTER=stub is for development and tests only/);
  });
});

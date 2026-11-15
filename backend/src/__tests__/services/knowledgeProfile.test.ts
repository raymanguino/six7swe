import type { PublishedProfileResponse } from '@six7swe/knowledge-types';
import { SERVICE_KEY_HEADER } from '@six7swe/knowledge-types';
import { createKnowledgeProfileClient } from '../../services/knowledge/profileClient';
import { mapPublishedProfile } from '../../services/knowledge/profileMapping';
import type { FetchLike } from '../../services/knowledge/transport';

const SERVICE_URL = 'http://knowledge.internal:3100';
const SERVICE_KEY = 's'.repeat(40);
const DOC_ID = '22222222-2222-4222-8222-222222222222';
const AT = '2026-11-14T10:00:00.000Z';

const pdfResume = {
  documentId: DOC_ID,
  filename: 'jordan.pdf',
  mimeType: 'application/pdf',
  isPdf: true,
  text: 'Jordan Example\nSenior Software Engineer',
  updatedAt: AT,
};

const published: PublishedProfileResponse = {
  profile: {
    stage: 'published',
    sourceDocumentId: DOC_ID,
    createdAt: AT,
    updatedAt: AT,
    data: {
      name: 'Jordan Example',
      title: 'Senior Software Engineer',
      location: 'Toronto, ON',
      summary: 'I build billing platforms.',
      skills: ['TypeScript', 'Kafka'],
      experience: [
        { title: 'Staff Engineer', company: 'Acme', period: '2021 - 2024', description: 'Led.' },
      ],
      projects: [{ name: 'Assistant', description: 'RAG.', technologies: ['pgvector'] }],
      links: {
        email: 'jordan@example.com',
        phone: null,
        linkedin: 'https://www.linkedin.com/in/jordan',
        github: 'https://github.com/jordan',
        website: 'https://jordan.example.com',
      },
    },
  },
  resume: pdfResume,
};

describe('mapPublishedProfile', () => {
  it('maps the published profile to the existing PortfolioData shape', () => {
    expect(mapPublishedProfile(published)).toEqual({
      profile: {
        id: 1,
        name: 'Jordan Example',
        title: 'Senior Software Engineer',
        email: 'jordan@example.com',
        phone: null,
        location: 'Toronto, ON',
        linkedinUrl: 'https://www.linkedin.com/in/jordan',
        githubUrl: 'https://github.com/jordan',
        summary: 'I build billing platforms.',
        skills: ['TypeScript', 'Kafka'],
        experience: [
          { title: 'Staff Engineer', company: 'Acme', period: '2021 - 2024', description: 'Led.' },
        ],
        projects: [{ name: 'Assistant', description: 'RAG.', technologies: ['pgvector'] }],
        fullResumeText: 'Jordan Example\nSenior Software Engineer',
        resumeFilename: 'jordan.pdf',
      },
      knowledgeResume: { filename: 'jordan.pdf', isPdf: true },
    });
  });

  it('has no profile before one is published, and no PDF for a Markdown resume', () => {
    const resume = { ...pdfResume, filename: 'resume.md', isPdf: false, text: null };
    expect(mapPublishedProfile({ profile: null, resume })).toEqual({
      profile: null,
      knowledgeResume: { filename: 'resume.md', isPdf: false },
    });
    const mapped = mapPublishedProfile({ ...published, resume });
    expect(mapped.profile).toMatchObject({ resumeFilename: null, fullResumeText: '' });
  });
});

describe('createKnowledgeProfileClient', () => {
  function client(respond: (url: string) => Response | Promise<Response>) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch: FetchLike = async (url, init) => {
      calls.push({ url, init });
      return respond(url);
    };
    return {
      calls,
      client: createKnowledgeProfileClient(
        { baseUrl: SERVICE_URL, key: SERVICE_KEY, timeoutMs: 1000 },
        fetch,
      ),
    };
  }

  it('reads the published profile with the service key', async () => {
    const { client: c, calls } = client(() => Response.json(published));
    expect(await c.getPublished()).toEqual(published);
    expect(calls[0]?.url).toBe(`${SERVICE_URL}/profile/published`);
    expect((calls[0]?.init.headers as Record<string, string>)[SERVICE_KEY_HEADER]).toBe(
      SERVICE_KEY,
    );
  });

  it('rejects an answer that breaks the contract, an error status, and an outage', async () => {
    await expect(
      client(() => Response.json({ profile: { name: 'x' } })).client.getPublished(),
    ).rejects.toThrow('did not match the contract');
    await expect(
      client(() => new Response('', { status: 500 })).client.getPublished(),
    ).rejects.toMatchObject({ status: 500 });
    await expect(
      client(() => Promise.reject(new TypeError('fetch failed'))).client.getPublished(),
    ).rejects.toThrow(/unreachable/);
  });

  it('returns the resume PDF bytes, or null when there is none', async () => {
    const pdf = Buffer.from('%PDF-1.4 test');
    const ok = client(
      () => new Response(new Uint8Array(pdf), { headers: { 'content-type': 'application/pdf' } }),
    );
    expect(await ok.client.getResumePdf()).toEqual(pdf);
    expect(ok.calls[0]?.url).toBe(`${SERVICE_URL}/resume.pdf`);

    expect(
      await client(() =>
        Response.json({ error: 'No PDF resume' }, { status: 404 }),
      ).client.getResumePdf(),
    ).toBeNull();
    await expect(
      client(() => Response.json({ not: 'a pdf' })).client.getResumePdf(),
    ).rejects.toThrow('did not send a PDF');
  });
});

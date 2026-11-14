/**
 * The structured profile's wire types (#86), as the backend's
 * `/knowledge/profile*` proxy relays them. Like `types.ts`, they mirror
 * `@six7swe/knowledge-types` (the profile schemas there are the contract and
 * validate every write), and the guards below check each response's shape
 * at runtime.
 */

export interface ProfileExperience {
  title: string;
  company: string;
  period: string;
  description: string;
}

export interface ProfileProject {
  name: string;
  description: string;
  technologies: string[];
}

export interface ProfileLinks {
  email: string | null;
  phone: string | null;
  linkedin: string | null;
  github: string | null;
  website: string | null;
}

export interface ProfileData {
  name: string;
  title: string;
  location: string | null;
  summary: string;
  skills: string[];
  experience: ProfileExperience[];
  projects: ProfileProject[];
  links: ProfileLinks;
}

export interface Profile {
  stage: 'draft' | 'published';
  data: ProfileData;
  sourceDocumentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DraftingStatus {
  enabled: boolean;
  state: 'idle' | 'drafting' | 'failed';
  documentId: string | null;
  error: string | null;
}

export interface ProfileState {
  draft: Profile | null;
  published: Profile | null;
  drafting: DraftingStatus;
}

export const LINK_KEYS = ['email', 'phone', 'linkedin', 'github', 'website'] as const;

export const EMPTY_PROFILE: ProfileData = {
  name: '',
  title: '',
  location: null,
  summary: '',
  skills: [],
  experience: [],
  projects: [],
  links: { email: null, phone: null, linkedin: null, github: null, website: null },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const isString = (value: unknown): value is string => typeof value === 'string';
const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === 'string';
const isStringList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(isString);

const isExperience = (value: unknown): value is ProfileExperience =>
  isRecord(value) &&
  isString(value.title) &&
  isString(value.company) &&
  isString(value.period) &&
  isString(value.description);

const isProject = (value: unknown): value is ProfileProject =>
  isRecord(value) &&
  isString(value.name) &&
  isString(value.description) &&
  isStringList(value.technologies);

const isLinks = (value: unknown): value is ProfileLinks =>
  isRecord(value) && LINK_KEYS.every((key) => isNullableString(value[key]));

const isProfileData = (value: unknown): value is ProfileData =>
  isRecord(value) &&
  isString(value.name) &&
  isString(value.title) &&
  isNullableString(value.location) &&
  isString(value.summary) &&
  isStringList(value.skills) &&
  Array.isArray(value.experience) &&
  value.experience.every(isExperience) &&
  Array.isArray(value.projects) &&
  value.projects.every(isProject) &&
  isLinks(value.links);

const isProfile = (value: unknown): value is Profile =>
  isRecord(value) &&
  (value.stage === 'draft' || value.stage === 'published') &&
  isProfileData(value.data) &&
  isNullableString(value.sourceDocumentId) &&
  isString(value.createdAt) &&
  isString(value.updatedAt);

const isDrafting = (value: unknown): value is DraftingStatus =>
  isRecord(value) &&
  typeof value.enabled === 'boolean' &&
  (value.state === 'idle' || value.state === 'drafting' || value.state === 'failed') &&
  isNullableString(value.documentId) &&
  isNullableString(value.error);

function invalid(what: string): never {
  throw new Error(`Unexpected ${what} response from the server`);
}

/** `GET /knowledge/profile`. */
export function parseProfileState(data: unknown): ProfileState {
  if (
    !isRecord(data) ||
    !(data.draft === null || isProfile(data.draft)) ||
    !(data.published === null || isProfile(data.published)) ||
    !isDrafting(data.drafting)
  ) {
    return invalid('profile');
  }
  return { draft: data.draft, published: data.published, drafting: data.drafting };
}

/** `PUT /knowledge/profile/draft` and `POST /knowledge/profile/publish`. */
export function parseProfileResponse(data: unknown): Profile {
  if (!isRecord(data) || !isProfile(data.profile)) return invalid('profile');
  return data.profile;
}

/** One comparable line of a profile, for the draft-vs-published diff. */
export interface DiffRow {
  label: string;
  published: string;
  draft: string;
  changed: boolean;
}

const formatExperience = (e: ProfileExperience) =>
  [`${e.title}, ${e.company}${e.period ? ` (${e.period})` : ''}`, e.description]
    .filter(Boolean)
    .join('\n');

const formatProject = (p: ProfileProject) =>
  [
    p.name,
    p.description,
    p.technologies.length > 0 ? `Technologies: ${p.technologies.join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

function flatten(data: ProfileData | null): Map<string, string> {
  const rows = new Map<string, string>();
  if (!data) return rows;
  rows.set('Name', data.name);
  rows.set('Title', data.title);
  rows.set('Location', data.location ?? '');
  rows.set('Summary', data.summary);
  rows.set('Skills', data.skills.join(', '));
  for (const key of LINK_KEYS) rows.set(`Link: ${key}`, data.links[key] ?? '');
  data.experience.forEach((e, i) => rows.set(`Experience ${i + 1}`, formatExperience(e)));
  data.projects.forEach((p, i) => rows.set(`Project ${i + 1}`, formatProject(p)));
  return rows;
}

/** Field-by-field comparison; with nothing published, every non-empty draft field is a change. */
export function diffProfiles(published: ProfileData | null, draft: ProfileData): DiffRow[] {
  const before = flatten(published);
  const after = flatten(draft);
  const labels = [...new Set([...after.keys(), ...before.keys()])];
  return labels
    .map((label) => {
      const p = before.get(label) ?? '';
      const d = after.get(label) ?? '';
      return { label, published: p, draft: d, changed: p !== d };
    })
    .filter((row) => row.published !== '' || row.draft !== '');
}

import { z } from 'zod';
import { PROFILE_LIMITS, ProfileDataSchema, type ProfileData } from '../../contract.js';

/**
 * Turns a model's JSON into a `ProfileData`, forgiving the slips models make
 * that have one obvious fix, and rejecting the rest:
 *
 * - an empty string where the contract wants null (a missing location or link);
 * - a link without a scheme (`github.com/x`), which gets `https://`;
 * - a link or email that is still invalid, which is dropped to null rather
 *   than failing the whole draft (the owner reviews every field anyway);
 * - missing lists, which become empty; blank list items, roles without both
 *   a title and a company, and projects without a name, which are dropped;
 *   lists longer than the limits, which are cut.
 *
 * Everything else, such as a missing name, goes through `ProfileDataSchema`
 * unchanged and fails there.
 */

const looseText = z
  .unknown()
  .transform((v) => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : ''));

const nullableText = looseText.transform((v) => (v === '' ? null : v));

const textList = z
  .array(looseText)
  .catch([])
  .transform((items) => [...new Set(items.filter((s) => s !== ''))]);

const LooseExperience = z.object({
  title: looseText,
  company: looseText,
  period: looseText,
  description: looseText,
});

const LooseProject = z.object({
  name: looseText,
  description: looseText,
  technologies: textList.transform((t) => t.slice(0, PROFILE_LIMITS.technologies)),
});

const LooseProfile = z.object({
  name: looseText,
  title: looseText,
  location: nullableText,
  summary: looseText,
  skills: textList.transform((s) => s.slice(0, PROFILE_LIMITS.skills)),
  experience: z.array(LooseExperience).catch([]),
  projects: z.array(LooseProject).catch([]),
  links: z
    .object({
      email: nullableText,
      phone: nullableText,
      linkedin: nullableText,
      github: nullableText,
      website: nullableText,
    })
    .catch({ email: null, phone: null, linkedin: null, github: null, website: null }),
});

const HttpLink = z.httpUrl().max(500);
const Email = z.email().max(254);

/** An http(s) URL, `https://` added when the scheme is missing; null when still invalid. */
export function normalizeLink(value: string | null): string | null {
  if (!value) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;
  const parsed = HttpLink.safeParse(withScheme);
  return parsed.success ? parsed.data : null;
}

function normalizeEmail(value: string | null): string | null {
  if (!value) return null;
  const parsed = Email.safeParse(value.replace(/^mailto:/i, ''));
  return parsed.success ? parsed.data : null;
}

/** Throws a ZodError when the input cannot be made into a valid profile. */
export function normalizeProfileDraft(raw: unknown): ProfileData {
  const loose = LooseProfile.parse(raw);
  return ProfileDataSchema.parse({
    ...loose,
    experience: loose.experience
      .filter((e) => e.title !== '' && e.company !== '')
      .slice(0, PROFILE_LIMITS.entries),
    projects: loose.projects.filter((p) => p.name !== '').slice(0, PROFILE_LIMITS.entries),
    links: {
      email: normalizeEmail(loose.links.email),
      phone: loose.links.phone,
      linkedin: normalizeLink(loose.links.linkedin),
      github: normalizeLink(loose.links.github),
      website: normalizeLink(loose.links.website),
    },
  });
}

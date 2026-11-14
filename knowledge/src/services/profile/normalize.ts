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
 * - text longer than its limit, which is cut to it (a phone number that long
 *   is dropped instead);
 * - missing lists, which become empty; blank list items, roles without both
 *   a title and a company, and projects without a name, which are dropped;
 *   lists longer than the limits, which are cut.
 *
 * Everything else, such as a missing name, goes through `ProfileDataSchema`
 * unchanged and fails there.
 */

/**
 * Cuts to `max` UTF-16 code units (what zod's `.max()` counts), never leaving
 * half a surrogate pair, and trims the cut end.
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end).trimEnd();
}

/** Any string or number as trimmed text, cut to `max`; anything else is ''. */
const looseText = (max: number) =>
  z
    .unknown()
    // A key the model left out is '' too; without the default, zod rejects it.
    .default('')
    .transform((v) =>
      truncate(typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '', max),
    );

const shortText = looseText(PROFILE_LIMITS.shortText);
const longText = looseText(PROFILE_LIMITS.longText);
/** Links and emails are not cut (a cut URL is a wrong URL); the checks below drop them instead. */
const rawText = looseText(Number.MAX_SAFE_INTEGER);

const orNull = (v: string) => (v === '' ? null : v);

const textList = (maxItems: number) =>
  z
    .array(shortText)
    .catch([])
    .transform((items) => [...new Set(items.filter((s) => s !== ''))].slice(0, maxItems));

const LooseExperience = z.object({
  title: shortText,
  company: shortText,
  period: shortText,
  description: longText,
});

const LooseProject = z.object({
  name: shortText,
  description: longText,
  technologies: textList(PROFILE_LIMITS.technologies),
});

const LooseProfile = z.object({
  name: shortText,
  title: shortText,
  location: shortText.transform(orNull),
  summary: longText,
  skills: textList(PROFILE_LIMITS.skills),
  experience: z.array(LooseExperience).catch([]),
  projects: z.array(LooseProject).catch([]),
  links: z
    .object({
      email: rawText.transform(orNull),
      phone: rawText.transform(orNull),
      linkedin: rawText.transform(orNull),
      github: rawText.transform(orNull),
      website: rawText.transform(orNull),
    })
    .catch({ email: null, phone: null, linkedin: null, github: null, website: null }),
});

const HttpLink = z.httpUrl().max(PROFILE_LIMITS.link);
const Email = z.email().max(PROFILE_LIMITS.email);

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
      // A phone number too long to be one is dropped, like an invalid link.
      phone:
        loose.links.phone && loose.links.phone.length <= PROFILE_LIMITS.phone
          ? loose.links.phone
          : null,
      linkedin: normalizeLink(loose.links.linkedin),
      github: normalizeLink(loose.links.github),
      website: normalizeLink(loose.links.website),
    },
  });
}

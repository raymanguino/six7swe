import { useState } from 'react';
import {
  LINK_KEYS,
  type ProfileData,
  type ProfileExperience,
  type ProfileLinks,
} from './profileTypes';

/** The form's own shape: every field is text, lists of names are comma-separated. */
interface ProjectForm {
  name: string;
  description: string;
  technologies: string;
}

interface ProfileForm {
  name: string;
  title: string;
  location: string;
  summary: string;
  skills: string;
  experience: ProfileExperience[];
  projects: ProjectForm[];
  links: Record<keyof ProfileLinks, string>;
}

const splitList = (text: string) =>
  text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);

const orNull = (text: string) => (text.trim() === '' ? null : text.trim());

function toForm(data: ProfileData): ProfileForm {
  return {
    name: data.name,
    title: data.title,
    location: data.location ?? '',
    summary: data.summary,
    skills: data.skills.join(', '),
    experience: data.experience.map((e) => ({ ...e })),
    projects: data.projects.map((p) => ({ ...p, technologies: p.technologies.join(', ') })),
    links: {
      email: data.links.email ?? '',
      phone: data.links.phone ?? '',
      linkedin: data.links.linkedin ?? '',
      github: data.links.github ?? '',
      website: data.links.website ?? '',
    },
  };
}

function toData(form: ProfileForm): ProfileData {
  return {
    name: form.name.trim(),
    title: form.title.trim(),
    location: orNull(form.location),
    summary: form.summary.trim(),
    skills: splitList(form.skills),
    experience: form.experience.map((e) => ({
      title: e.title.trim(),
      company: e.company.trim(),
      period: e.period.trim(),
      description: e.description.trim(),
    })),
    projects: form.projects.map((p) => ({
      name: p.name.trim(),
      description: p.description.trim(),
      technologies: splitList(p.technologies),
    })),
    links: {
      email: orNull(form.links.email),
      phone: orNull(form.links.phone),
      linkedin: orNull(form.links.linkedin),
      github: orNull(form.links.github),
      website: orNull(form.links.website),
    },
  };
}

const inputClass =
  'w-full rounded-lg border border-gray-300 px-3 py-2 text-sm dark:border-gray-600 dark:bg-gray-700 dark:text-white';
const labelClass = 'mb-1 block text-sm font-medium text-gray-700 dark:text-gray-300';
const smallButton =
  'rounded-lg border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700';

const LINK_LABELS: Record<keyof ProfileLinks, string> = {
  email: 'Email (the contact form delivers here)',
  phone: 'Phone',
  linkedin: 'LinkedIn URL',
  github: 'GitHub URL',
  website: 'Website URL',
};

interface Props {
  initial: ProfileData;
  saving: boolean;
  /** Resolves true when the draft was saved, which closes the editor. */
  onSave: (data: ProfileData) => Promise<boolean>;
  onCancel: () => void;
}

/**
 * Edits a draft profile. The service validates every save against the
 * contract (http(s) links only, length limits) and the page shows its answer.
 */
export default function ProfileDraftEditor({ initial, saving, onSave, onCancel }: Props) {
  const [form, setForm] = useState<ProfileForm>(() => toForm(initial));

  const set = <K extends keyof ProfileForm>(key: K, value: ProfileForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const setExperience = (i: number, patch: Partial<ProfileExperience>) =>
    set(
      'experience',
      form.experience.map((e, j) => (j === i ? { ...e, ...patch } : e)),
    );
  const setProject = (i: number, patch: Partial<ProjectForm>) =>
    set(
      'projects',
      form.projects.map((p, j) => (j === i ? { ...p, ...patch } : p)),
    );

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (await onSave(toData(form))) onCancel();
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="profile-name" className={labelClass}>
            Name
          </label>
          <input
            id="profile-name"
            required
            maxLength={200}
            value={form.name}
            onChange={(e) => set('name', e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="profile-title" className={labelClass}>
            Title
          </label>
          <input
            id="profile-title"
            required
            maxLength={200}
            value={form.title}
            onChange={(e) => set('title', e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label htmlFor="profile-location" className={labelClass}>
            Location
          </label>
          <input
            id="profile-location"
            maxLength={200}
            value={form.location}
            onChange={(e) => set('location', e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label htmlFor="profile-summary" className={labelClass}>
          Summary
        </label>
        <textarea
          id="profile-summary"
          rows={4}
          maxLength={4000}
          value={form.summary}
          onChange={(e) => set('summary', e.target.value)}
          className={inputClass}
        />
      </div>

      <div>
        <label htmlFor="profile-skills" className={labelClass}>
          Skills (comma-separated)
        </label>
        <textarea
          id="profile-skills"
          rows={2}
          value={form.skills}
          onChange={(e) => set('skills', e.target.value)}
          className={inputClass}
        />
      </div>

      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">Links</legend>
        {LINK_KEYS.map((key) => (
          <div key={key}>
            <label htmlFor={`profile-link-${key}`} className={labelClass}>
              {LINK_LABELS[key]}
            </label>
            <input
              id={`profile-link-${key}`}
              type={key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'url'}
              value={form.links[key]}
              onChange={(e) => set('links', { ...form.links, [key]: e.target.value })}
              className={inputClass}
            />
          </div>
        ))}
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
          Experience
        </legend>
        {form.experience.map((e, i) => (
          <div
            key={i}
            className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <div className="grid gap-2 sm:grid-cols-3">
              <input
                aria-label={`Experience ${i + 1} title`}
                placeholder="Title"
                required
                value={e.title}
                onChange={(ev) => setExperience(i, { title: ev.target.value })}
                className={inputClass}
              />
              <input
                aria-label={`Experience ${i + 1} company`}
                placeholder="Company"
                required
                value={e.company}
                onChange={(ev) => setExperience(i, { company: ev.target.value })}
                className={inputClass}
              />
              <input
                aria-label={`Experience ${i + 1} period`}
                placeholder="2021 - 2024"
                value={e.period}
                onChange={(ev) => setExperience(i, { period: ev.target.value })}
                className={inputClass}
              />
            </div>
            <textarea
              aria-label={`Experience ${i + 1} description`}
              rows={2}
              value={e.description}
              onChange={(ev) => setExperience(i, { description: ev.target.value })}
              className={inputClass}
            />
            <button
              type="button"
              className={smallButton}
              onClick={() =>
                set(
                  'experience',
                  form.experience.filter((_, j) => j !== i),
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className={smallButton}
          onClick={() =>
            set('experience', [
              ...form.experience,
              { title: '', company: '', period: '', description: '' },
            ])
          }
        >
          Add role
        </button>
      </fieldset>

      <fieldset className="space-y-3">
        <legend className="mb-2 text-sm font-semibold text-gray-900 dark:text-white">
          Projects
        </legend>
        {form.projects.map((p, i) => (
          <div
            key={i}
            className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-gray-700"
          >
            <div className="grid gap-2 sm:grid-cols-2">
              <input
                aria-label={`Project ${i + 1} name`}
                placeholder="Name"
                required
                value={p.name}
                onChange={(ev) => setProject(i, { name: ev.target.value })}
                className={inputClass}
              />
              <input
                aria-label={`Project ${i + 1} technologies`}
                placeholder="Technologies, comma-separated"
                value={p.technologies}
                onChange={(ev) => setProject(i, { technologies: ev.target.value })}
                className={inputClass}
              />
            </div>
            <textarea
              aria-label={`Project ${i + 1} description`}
              rows={2}
              value={p.description}
              onChange={(ev) => setProject(i, { description: ev.target.value })}
              className={inputClass}
            />
            <button
              type="button"
              className={smallButton}
              onClick={() =>
                set(
                  'projects',
                  form.projects.filter((_, j) => j !== i),
                )
              }
            >
              Remove
            </button>
          </div>
        ))}
        <button
          type="button"
          className={smallButton}
          onClick={() =>
            set('projects', [...form.projects, { name: '', description: '', technologies: '' }])
          }
        >
          Add project
        </button>
      </fieldset>

      <div className="flex gap-3">
        <button
          type="submit"
          disabled={saving}
          className="rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-primary-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save draft'}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}

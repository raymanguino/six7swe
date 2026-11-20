import { useState, useEffect, useRef, useCallback } from 'react';
import { apiRequest, apiUrl } from '../utils/api';
import { useResumeAvailable } from '../hooks/useResumeAvailable';
import { INPUT_LIMITS } from '../constants';
import { CONTACT } from '../content/contact';
import {
  ABOUT_STRENGTH_COLUMNS,
  EXPERIENCE,
  PROJECT_TILES,
  SKILL_LEVEL_CONFIG,
  SKILLS_GROUPS,
  HOBBIES,
  type AccordionContent,
  type ProjectTile,
} from '../content/landing';

export type SectionId = 'home' | 'about' | 'projects' | 'skills' | 'hobbies' | 'fitcheck' | 'contacts';


function ProgressBar({ percent }: { percent: number | null }) {
  if (percent == null) return <span className="text-sm text-gray-500 dark:text-gray-400">—</span>;
  return (
    <div className="w-full bg-gray-200 dark:bg-gray-600 rounded-full h-2">
      <div
        className="bg-primary-600 dark:bg-primary-400 h-2 rounded-full transition-all duration-500"
        style={{ width: `${percent}%` }}
      />
    </div>
  );
}

interface LandingProps {
  onSectionChange: (section: SectionId) => void;
}

function ExperienceAccordion({
  jobKey,
  pointIndex,
  summary,
  accordion,
  isExpanded,
  onToggle,
}: {
  jobKey: string;
  pointIndex: number;
  summary: string;
  accordion: AccordionContent;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const id = `${jobKey}-${pointIndex}`;
  return (
    <li className="list-none">
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-controls={`accordion-content-${id}`}
          id={`accordion-trigger-${id}`}
          className="text-left font-medium text-gray-700 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400 flex items-start gap-2 group"
        >
          <span className="flex-shrink-0 mt-0.5 w-4 h-4 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-primary-400 flex items-center justify-center text-white text-xs">
            {isExpanded ? '−' : '+'}
          </span>
          <span>{summary}</span>
        </button>
        <div
          id={`accordion-content-${id}`}
          role="region"
          aria-labelledby={`accordion-trigger-${id}`}
          hidden={!isExpanded}
          className="overflow-hidden"
        >
          {isExpanded && (
            <div className="ml-6 pl-2 border-l-2 border-primary-200 dark:border-primary-600 space-y-3 text-sm text-gray-600 dark:text-gray-400">
              <div>
                <span className="font-semibold text-gray-800 dark:text-gray-200 block mb-0.5">Situation</span>
                <p>{accordion.situation}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 dark:text-gray-200 block mb-0.5">Approach</span>
                <p>{accordion.approach}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 dark:text-gray-200 block mb-0.5">Technical work</span>
                <p>{accordion.technicalWork}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 dark:text-gray-200 block mb-0.5">Lessons learned</span>
                <p>{accordion.lessonsLearned}</p>
              </div>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

function ProjectTileCard({
  project,
  isExpanded,
  onToggle,
}: {
  project: ProjectTile;
  isExpanded: boolean;
  onToggle: () => void;
}) {
  const accordionId = `project-accordion-${project.id}`;
  const contentId = `project-content-${project.id}`;
  return (
    <div className="card border border-transparent hover:border-primary-200 dark:hover:border-primary-600 transition-shadow hover:shadow-lg">
      <h3 className="text-xl font-semibold text-gray-900 dark:text-white mb-3">{project.title}</h3>
      {project.briefDescription && (
        <p className="text-gray-600 dark:text-gray-400 text-sm mb-4">{project.briefDescription}</p>
      )}
      {project.repoUrl && (
        <a
          href={project.repoUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block text-sm font-medium text-primary-600 dark:text-primary-400 hover:underline mb-4"
        >
          View code on GitHub ↗
        </a>
      )}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={isExpanded}
          aria-controls={contentId}
          id={accordionId}
          className="text-left font-medium text-gray-700 dark:text-gray-300 hover:text-primary-600 dark:hover:text-primary-400 flex items-center gap-2 group"
        >
          <span className="flex-shrink-0 w-4 h-4 rounded-full bg-gray-300 dark:bg-gray-600 group-hover:bg-primary-400 flex items-center justify-center text-white text-xs">
            {isExpanded ? '−' : '+'}
          </span>
          <span>View Details</span>
        </button>
        <div
          id={contentId}
          role="region"
          aria-labelledby={accordionId}
          hidden={!isExpanded}
          className="overflow-hidden"
        >
          {isExpanded && (
            <div className="ml-6 pl-2 border-l-2 border-primary-200 dark:border-primary-600 space-y-3 text-sm text-gray-600 dark:text-gray-400">
              <div>
                <span className="font-semibold text-gray-800 dark:text-gray-200 block mb-0.5">Project Overview</span>
                <p>{project.overview}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 dark:text-gray-200 block mb-0.5">Key Challenges</span>
                <ul className="list-disc list-inside space-y-1">
                  {project.keyChallenges.map((challenge, i) => (
                    <li key={i}>{challenge}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type FitCheckResult = {
  snarkyPreamble?: string | null;
  verdict: 'strong' | 'weak';
  whereIMatch?: Array<{ heading: string; details: string }>;
  gapsToNote?: Array<{ heading: string; details: string }>;
  whereIDontFit?: Array<{ heading: string; details: string }>;
  whatDoesTransfer?: string;
  recommendation: string;
};

export default function Landing({ onSectionChange }: LandingProps) {
  const [formData, setFormData] = useState({ name: '', email: '', message: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [expandedAccordion, setExpandedAccordion] = useState<string | null>(null);
  const resumeAvailable = useResumeAvailable();
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);
  const [fitcheckJobDescription, setFitcheckJobDescription] = useState('');
  const [fitcheckLoading, setFitcheckLoading] = useState(false);
  const [fitcheckResult, setFitcheckResult] = useState<FitCheckResult | null>(null);
  const [fitcheckError, setFitcheckError] = useState<string | null>(null);

  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    home: null,
    about: null,
    projects: null,
    skills: null,
    hobbies: null,
    fitcheck: null,
    contacts: null,
  });

  const allSectionIds: SectionId[] = ['home', 'about', 'projects', 'skills', 'hobbies', 'fitcheck', 'contacts'];

  useEffect(() => {
    const hash = window.location.hash.slice(1) as SectionId | '';
    if (hash && allSectionIds.includes(hash)) {
      const el = document.getElementById(hash);
      if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, []);

  const handleFitcheckSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fitcheckJobDescription.trim()) return;
    setFitcheckLoading(true);
    setFitcheckError(null);
    setFitcheckResult(null);
    try {
      const data = await apiRequest('/fitcheck', {
        method: 'POST',
        body: JSON.stringify({ jobDescription: fitcheckJobDescription.trim() }),
      }) as FitCheckResult;
      setFitcheckResult(data);
    } catch {
      setFitcheckError('Failed to analyze job fit. Please try again.');
    } finally {
      setFitcheckLoading(false);
    }
  };

  const handleContactSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    setSubmitStatus('idle');
    try {
      await apiRequest('/contact', {
        method: 'POST',
        body: JSON.stringify({ ...formData, company: '' }),
      });
      setSubmitStatus('success');
      setFormData({ name: '', email: '', message: '' });
    } catch {
      setSubmitStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  };

  const updateActiveSection = useCallback(() => {
    const viewportMid = window.scrollY + window.innerHeight / 2;
    let active: SectionId = 'home';
    let minDistance = Infinity;
    for (const id of allSectionIds) {
      const el = sectionRefs.current[id];
      if (!el) continue;
      const rect = el.getBoundingClientRect();
      const mid = rect.top + window.scrollY + rect.height / 2;
      const distance = Math.abs(viewportMid - mid);
      if (distance < minDistance) {
        minDistance = distance;
        active = id;
      }
    }
    onSectionChange(active);
  }, [onSectionChange]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      () => updateActiveSection(),
      { root: null, rootMargin: '-20% 0px -60% 0px', threshold: 0 }
    );
    allSectionIds.forEach((id) => {
      const el = sectionRefs.current[id];
      if (el) observer.observe(el);
    });
    updateActiveSection();
    return () => observer.disconnect();
  }, [updateActiveSection]);

  useEffect(() => {
    const handleScroll = () => updateActiveSection();
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [updateActiveSection]);

  return (
    <div className="container mx-auto px-12 md:px-24 py-12 max-w-6xl">
      {/* Welcome.init() */}
      <section
        id="home"
        ref={(el) => { sectionRefs.current.home = el; }}
        className="scroll-mt-24 mb-24"
      >
        <div className="text-center mb-12">
          <p className="text-xl md:text-2xl text-gray-700 dark:text-gray-300 mb-4">My name is Ray Manguino ...</p>
          <p className="text-lg text-primary-600 dark:text-primary-400 font-semibold mb-6">
            AI API Engineer · Building production LLM systems, agentic workflows, and the APIs that make them usable
          </p>
          <div className="max-w-3xl mx-auto">
            <p className="text-lg text-gray-700 dark:text-gray-300 leading-relaxed">
              I design and build the API and infrastructure layer for AI-powered systems — RAG pipelines, LLM evals, MCP tooling, and the guardrails that make LLM features reliable in production. Fifteen years of backend and distributed systems experience, now applied to production AI, including the knowledge service behind this site's chat and the agent that reviews every change to it.
            </p>
          </div>
        </div>
      </section>

      {/* About.go */}
      <section
        id="about"
        ref={(el) => { sectionRefs.current.about = el; }}
        className="scroll-mt-24 mb-24"
      >
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-2 text-center">About Me</h2>
        <p className="text-center text-gray-600 dark:text-gray-400 mb-2 max-w-2xl mx-auto">
          Architecting scalable and intelligent systems with security-first approach
        </p>
        <div className="text-gray-700 dark:text-gray-300 leading-relaxed mb-10 max-w-3xl mx-auto space-y-6">
          <p>
            I'm a backend engineer specializing in the API and infrastructure layer for AI systems. My work sits at the intersection of distributed systems engineering and applied AI — designing the service architecture, data pipelines, and tool interfaces that make LLM-powered products production-ready.
          </p>
          <p>
            I've spent fifteen years building software, most recently at Capital One, Nacelle, and Tanium — distributed GraphQL systems, high-throughput ingestion pipelines, cloud migrations, and the monitoring infrastructure that keeps them running. Since 2025 I've focused on AI through six7swe, my own production platform: a RAG knowledge service on pgvector with an evolving eval set, an LLM agent that reviews every pull request with prompt-injection defences enforced in code, and a Claude Code workflow of subagents that takes a GitHub epic to reviewed pull requests.
          </p>
          <p>
            I'm looking for a senior AI API engineering role where I can own the full stack from prompt to API response — building AI features that are reliable, observable, and actually usable by the teams and customers they serve.
          </p>
        </div>

        <div className="grid sm:grid-cols-3 gap-6 mb-12">
          {ABOUT_STRENGTH_COLUMNS.map((col) => (
            <div key={col.title} className="card">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-4 border-b border-gray-200 dark:border-gray-600 pb-2">
                {col.title}
              </h3>
              <ul className="space-y-3">
                {col.items.map((item) => (
                  <li key={item} className="flex items-center gap-2 text-gray-700 dark:text-gray-300">
                    {col.icon === 'check' && (
                      <span className={`flex-shrink-0 ${col.iconClass}`} aria-hidden>
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      </span>
                    )}
                    {col.icon === 'circle' && (
                      <span className={`flex-shrink-0 w-5 h-5 rounded-full border-2 bg-transparent ${col.iconClass}`} aria-hidden />
                    )}
                    {col.icon === 'tools' && (
                      <span className={`flex-shrink-0 ${col.iconClass}`} aria-hidden>
                        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth="2">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M14.7 6.3a4.5 4.5 0 01-5.85 5.85l-5.4 5.4a2 2 0 102.83 2.83l5.4-5.4a4.5 4.5 0 005.85-5.85l-2.3 2.3a1 1 0 01-1.42 0l-1.42-1.42a1 1 0 010-1.42l2.3-2.3z" />
                        </svg>
                      </span>
                    )}
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Experience</h3>
        <div className="space-y-6">
          {EXPERIENCE.map((job) => (
            <div key={`${job.company}-${job.title}`} className="card">
              <div className="flex justify-between items-baseline gap-4">
                <h4 className="text-lg font-semibold text-gray-900 dark:text-white">{job.title}</h4>
                <span className="text-gray-600 dark:text-gray-400 text-sm shrink-0">{job.period}</span>
              </div>
              <p className="text-primary-600 dark:text-primary-400 font-medium">{job.company}</p>
              <ul className="mt-3 space-y-4 text-gray-700 dark:text-gray-300">
                {job.points.map((point, i) => {
                  const accordionKey = `${job.company}-${i}`;
                  return (
                    <ExperienceAccordion
                      key={accordionKey}
                      jobKey={accordionKey}
                      pointIndex={i}
                      summary={point.summary}
                      accordion={point.accordion}
                      isExpanded={expandedAccordion === accordionKey}
                      onToggle={() => setExpandedAccordion((prev) => (prev === accordionKey ? null : accordionKey))}
                    />
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      </section>

      {/* Projects.ai */}
      <section
        id="projects"
        ref={(el) => { sectionRefs.current.projects = el; }}
        className="scroll-mt-24 mb-24"
      >
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-8 text-center">Latest Projects</h2>
        <div className="grid md:grid-cols-2 gap-6">
          {PROJECT_TILES.map((project) => (
            <ProjectTileCard
              key={project.id}
              project={project}
              isExpanded={expandedProjectId === project.id}
              onToggle={() => setExpandedProjectId((prev) => (prev === project.id ? null : project.id))}
            />
          ))}
        </div>
      </section>

      {/* Skills.js */}
      <section
        id="skills"
        ref={(el) => { sectionRefs.current.skills = el; }}
        className="scroll-mt-24 mb-24"
      >
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-2 text-center">Technical Expertise</h2>
        <p className="text-center text-gray-600 dark:text-gray-400 mb-10">Distributed systems and AI-focused technology stack</p>
        <div className="grid md:grid-cols-2 gap-8">
          {SKILLS_GROUPS.map((group) => (
            <div key={group.name} className="card">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4 border-b border-gray-200 dark:border-gray-600 pb-2">{group.name}</h3>
              <div className="space-y-4">
                {group.items.map((item) => {
                  const levelConfig = item.level ? SKILL_LEVEL_CONFIG[item.level] : null;
                  return (
                    <div key={item.name}>
                      <div className="flex justify-between items-center mb-1">
                        <span className="font-medium text-gray-800 dark:text-gray-200">{item.name}</span>
                        <div className="flex items-center gap-2">
                          {levelConfig && (
                            <span className="flex items-center gap-1.5 text-sm text-gray-600 dark:text-gray-400">
                              <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${levelConfig.dotClass}`} aria-hidden />
                              {levelConfig.label}
                            </span>
                          )}
                        </div>
                      </div>
                      <ProgressBar percent={item.percent} />
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Hobbies.fun */}
      <section
        id="hobbies"
        ref={(el) => { sectionRefs.current.hobbies = el; }}
        className="scroll-mt-24 mb-24"
      >
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-4 text-center">Life Beyond Code</h2>
        <p className="text-center text-gray-600 dark:text-gray-400 mb-8 max-w-2xl mx-auto">
          Welcome to my hobbies! Each passion tells a story of precision, creativity, and problem solving.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          {HOBBIES.map((hobby) => (
            <div key={hobby.title} className="card">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">{hobby.title}</h3>
              <p className="text-gray-600 dark:text-gray-400 mb-4">{hobby.summary}</p>
              <p className="text-sm text-gray-700 dark:text-gray-300 italic border-l-2 border-primary-200 dark:border-primary-600 pl-3">{hobby.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FitCheck.dll */}
      <section
        id="fitcheck"
        ref={(el) => { sectionRefs.current.fitcheck = el; }}
        className="scroll-mt-24 mb-24"
      >
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-4 text-center">Honest Fit Assessment</h2>
        <p className="text-center text-gray-600 dark:text-gray-400 mb-8 max-w-2xl mx-auto">
          Paste a job description and I&apos;ll give you an honest assessment of how my experience aligns—or doesn&apos;t.
        </p>

        <form onSubmit={handleFitcheckSubmit} className="max-w-3xl mx-auto mb-8">
          <label htmlFor="fitcheck-job" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            <span className="inline-flex items-center gap-2">
              <span
                className="relative inline-block w-2.5 h-2.5 rounded-full bg-emerald-400 shrink-0"
                style={{
                  boxShadow:
                    '0 0 3px 1px rgba(52, 211, 153, 0.5), 0 0 6px 2px rgba(52, 211, 153, 0.25), inset 0 0 2px 0 rgba(255, 255, 255, 0.4)',
                }}
                aria-hidden
              />
              Ready to assess job fit
            </span>
          </label>
          <textarea
            id="fitcheck-job"
            value={fitcheckJobDescription}
            onChange={(e) => setFitcheckJobDescription(e.target.value.slice(0, INPUT_LIMITS.jobDescription))}
            placeholder="Paste the full job description here..."
            rows={8}
            maxLength={INPUT_LIMITS.jobDescription}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500 resize-y mb-4"
            disabled={fitcheckLoading}
          />
          <button
            type="submit"
            disabled={fitcheckLoading || !fitcheckJobDescription.trim()}
            className="btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {fitcheckLoading ? 'Analyzing...' : 'Check Fit'}
          </button>
        </form>

        {fitcheckError && (
          <div className="max-w-3xl mx-auto mb-8 p-4 bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg">
            <p className="text-red-800 dark:text-red-200 text-sm">{fitcheckError}</p>
          </div>
        )}

        {fitcheckResult && (
          <div className="max-w-3xl mx-auto space-y-6">
            {fitcheckResult.snarkyPreamble && (
              <p className="text-amber-700 dark:text-amber-300 italic font-medium border-l-4 border-amber-400 dark:border-amber-500 pl-4 py-2 bg-amber-50/50 dark:bg-amber-900/20 rounded-r">
                {fitcheckResult.snarkyPreamble}
              </p>
            )}
            {fitcheckResult.verdict === 'strong' ? (
              <div className="card border-primary-200 dark:border-primary-600 bg-primary-50/30 dark:bg-primary-900/30">
                <h3 className="text-xl font-bold text-primary-800 dark:text-primary-200 mb-2">Strong Fit - Let&apos;s Talk</h3>
                <p className="font-medium text-gray-800 dark:text-gray-200 mb-6">Your requirements align well with my experience. Here&apos;s the specific evidence:</p>
                {fitcheckResult.whereIMatch && fitcheckResult.whereIMatch.length > 0 && (
                  <div className="mb-6">
                    <h4 className="font-semibold text-gray-900 dark:text-white mb-3">Where I Match</h4>
                    <ul className="space-y-3">
                      {fitcheckResult.whereIMatch.map((item, i) => (
                        <li key={i} className="pl-2 border-l-2 border-primary-400 dark:border-primary-500">
                          <span className="font-medium text-gray-800 dark:text-gray-200">{item.heading}</span>
                          <p className="text-gray-700 dark:text-gray-300 text-sm mt-1">{item.details}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {fitcheckResult.gapsToNote && fitcheckResult.gapsToNote.length > 0 && (
                  <div className="mb-6">
                    <h4 className="font-semibold text-gray-900 dark:text-white mb-3">Gaps To Note</h4>
                    <ul className="space-y-3">
                      {fitcheckResult.gapsToNote.map((item, i) => (
                        <li key={i} className="pl-2 border-l-2 border-amber-400 dark:border-amber-500">
                          <span className="font-medium text-gray-800 dark:text-gray-200">{item.heading}</span>
                          <p className="text-gray-700 dark:text-gray-300 text-sm mt-1">{item.details}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white mb-2">My Recommendation</h4>
                  <p className="text-gray-700 dark:text-gray-300">{fitcheckResult.recommendation}</p>
                </div>
              </div>
            ) : (
              <div className="card border-amber-200 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/20">
                <h3 className="text-xl font-bold text-amber-800 dark:text-amber-200 mb-2">Honest Assessment - Probably Not Your Person</h3>
                <p className="font-medium text-gray-800 dark:text-gray-200 mb-6">I want to be direct with you. Here&apos;s why this might not be the right fit:</p>
                {fitcheckResult.whereIDontFit && fitcheckResult.whereIDontFit.length > 0 && (
                  <div className="mb-6">
                    <h4 className="font-semibold text-gray-900 dark:text-white mb-3">Where I Don&apos;t Fit</h4>
                    <ul className="space-y-3">
                      {fitcheckResult.whereIDontFit.map((item, i) => (
                        <li key={i} className="pl-2 border-l-2 border-amber-400 dark:border-amber-500">
                          <span className="font-medium text-gray-800 dark:text-gray-200">{item.heading}</span>
                          <p className="text-gray-700 dark:text-gray-300 text-sm mt-1">{item.details}</p>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {fitcheckResult.whatDoesTransfer && (
                  <div className="mb-6">
                    <h4 className="font-semibold text-gray-900 dark:text-white mb-2">What Does Transfer</h4>
                    <p className="text-gray-700 dark:text-gray-300">{fitcheckResult.whatDoesTransfer}</p>
                  </div>
                )}
                <div>
                  <h4 className="font-semibold text-gray-900 dark:text-white mb-2">My Recommendation</h4>
                  <p className="text-gray-700 dark:text-gray-300">{fitcheckResult.recommendation}</p>
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      {/* Contact.json */}
      <section
        id="contacts"
        ref={(el) => { sectionRefs.current.contacts = el; }}
        className="scroll-mt-24"
      >
        <h2 className="text-2xl font-semibold text-gray-800 dark:text-gray-200 mb-2 text-center">Let's Work Together</h2>
        <p className="text-center text-gray-600 dark:text-gray-400 mb-8">Ready to bring your ideas to life</p>
        <p className="text-center text-gray-700 dark:text-gray-300 mb-10 max-w-xl mx-auto">
          I'm always excited to work and collaborate with amazing people. Let's create something extraordinary together.
        </p>

        <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          <div className="space-y-6">
            <div className="card">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Get In Touch</h3>
              {CONTACT.email && (
                <p className="text-gray-700 dark:text-gray-300 flex items-center gap-2">
                  <svg className="w-5 h-5 shrink-0 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                  </svg>
                  <a href={`mailto:${CONTACT.email}`} className="text-primary-600 dark:text-primary-400 hover:underline">{CONTACT.email}</a>
                </p>
              )}
              {CONTACT.phone && (
                <p className="text-gray-700 dark:text-gray-300 mt-2 flex items-center gap-2">
                  <svg className="w-5 h-5 shrink-0 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                  </svg>
                  {CONTACT.phone}
                </p>
              )}
              {CONTACT.location && (
                <p className="text-gray-700 dark:text-gray-300 mt-2 flex items-center gap-2">
                  <svg className="w-5 h-5 shrink-0 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                  </svg>
                  {CONTACT.location}
                </p>
              )}
            </div>
            {(CONTACT.githubUrl || CONTACT.linkedinUrl) && (
              <div className="card">
                <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Social Links</h3>
                <div className="flex flex-col gap-2">
                  {CONTACT.githubUrl && (
                    <a href={CONTACT.githubUrl} target="_blank" rel="noopener noreferrer" className="text-primary-600 dark:text-primary-400 hover:underline inline-flex items-center gap-2">
                      <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                      </svg>
                      Github
                    </a>
                  )}
                  {CONTACT.linkedinUrl && (
                    <a href={CONTACT.linkedinUrl} target="_blank" rel="noopener noreferrer" className="text-primary-600 dark:text-primary-400 hover:underline inline-flex items-center gap-2">
                      <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                      </svg>
                      LinkedIn
                    </a>
                  )}
                </div>
              </div>
            )}
            {resumeAvailable && (
            <div className="card">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Resume</h3>
              <a
                href={apiUrl('/resume')}
                download="resume.pdf"
                className="text-primary-600 dark:text-primary-400 hover:underline inline-flex items-center gap-2"
              >
                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download
              </a>
            </div>
            )}
          </div>
          <div className="card">
            <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Send Message</h3>
            <form onSubmit={handleContactSubmit} className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Your Name</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value.slice(0, INPUT_LIMITS.name) })}
                  required
                  maxLength={INPUT_LIMITS.name}
                  autoComplete="name"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Your Email</label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value.slice(0, INPUT_LIMITS.email) })}
                  required
                  maxLength={INPUT_LIMITS.email}
                  autoComplete="email"
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label htmlFor="message" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Your Message</label>
                <textarea
                  id="message"
                  name="message"
                  value={formData.message}
                  onChange={(e) => setFormData({ ...formData, message: e.target.value.slice(0, INPUT_LIMITS.message) })}
                  required
                  rows={5}
                  maxLength={INPUT_LIMITS.message}
                  className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              {submitStatus === 'success' && (
                <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 rounded-lg p-3">
                  <p className="text-green-800 dark:text-green-200 text-sm">Thank you! Your message has been sent successfully.</p>
                </div>
              )}
              {submitStatus === 'error' && (
                <div className="bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-700 rounded-lg p-3">
                  <p className="text-red-800 dark:text-red-200 text-sm">Failed to send message. Please try again later.</p>
                </div>
              )}
              <button
                type="submit"
                disabled={isSubmitting}
                className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? 'Sending...' : 'Send Message'}
              </button>
            </form>
          </div>
        </div>
      </section>

      <footer className="mt-24 pt-8 border-t border-gray-200 dark:border-gray-700 text-center text-sm text-gray-500 dark:text-gray-400">
        © 2026 Ray Manguino | All rights reserved.
      </footer>
    </div>
  );
}

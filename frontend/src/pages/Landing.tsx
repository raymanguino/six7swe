import { useState, useEffect, useRef, useCallback } from 'react';
import { apiRequest } from '../utils/api';
import { INPUT_LIMITS } from '../constants';

export type SectionId = 'home' | 'about' | 'projects' | 'skills' | 'hobbies' | 'fitcheck' | 'contacts';

const ABOUT_SKILLS = [
  { label: 'AI & MCP Systems', percent: 75 },
  { label: 'Backend Development', percent: 100 },
  { label: 'Frontend Development', percent: 75 },
  { label: 'Team Leadership', percent: 85 },
  { label: 'API & Data Security', percent: 100 },
];

type AccordionContent = {
  situation: string;
  approach: string;
  technicalWork: string;
  lessonsLearned: string;
};

const EXPERIENCE: Array<{
  title: string;
  company: string;
  period: string;
  points: Array<{ summary: string; accordion: AccordionContent }>;
}> = [
  {
    title: 'Senior Software Engineer',
    company: 'Tanium',
    period: 'Previous',
    points: [
      {
        summary: 'Designed and delivered new GraphQL APIs adopted by 1,500 customers, replacing fragmented REST calls and cutting troubleshooting time from ~1 hour to minutes.',
        accordion: {
          situation: 'Customers using legacy APIs mounting complaints about instability and state inconsistencies/errors in workflows even though modern APIs exist, leading to increased support call volumes and degraded user experiences.',
          approach: 'Worked directly with support teams and customers using the APIs to fully understand intent and areas of concern with current workflows. Discovered technical limitations preventing customers from migrating to the modern APIs and root causes.',
          technicalWork: 'Updated modern APIs with extended filtering capabilities that would unblock customers from migrating to them. Created detailed migration plans to guide customers to the modern APIs with minimum friction. Updated documentation to clearly communicate API usage and migration plans.',
          lessonsLearned: 'Sometimes technical problems are disguised as communication problems. Maintaining clear and up to date documentation gives customers the best chance at resolving issues on their own and not have to rely on costly engineering resources.',
        },
      },
      {
        summary: 'Built and optimized monitoring and alerting systems, cutting response times by 50% and reducing noise volume by 70%.',
        accordion: {
          situation: 'Support and operations were dealing with slow incident response and alert fatigue—too much noise made it hard to focus on real issues, and delayed response times impacted customer-facing stability.',
          approach: 'Analyzed alert sources and response workflows to identify root causes of latency and noise. Drove cross-functional alignment on long-term API strategy, documentation standards, schema governance, and monitoring.',
          technicalWork: 'Built and optimized monitoring and alerting systems: 50% faster response and 70% reduction in noise volume. Aligned with stakeholders on monitoring standards and ensured observability was part of the API and deployment strategy.',
          lessonsLearned: 'Investing in observability pays off in both incident response and team focus; reducing noise means real issues get attention and customers benefit from faster resolution.',
        },
      },
    ],
  },
  {
    title: 'Senior Software Engineer',
    company: 'Nacelle',
    period: 'Previous',
    points: [
      {
        summary: 'Architected and delivered API layer services to provide dynamically generated GraphQL endpoints for improved user experiences.',
        accordion: {
          situation: 'Customers needed dynamically generated, customer-specific GraphQL APIs to scale without dedicated engineering support; existing APIs and data infrastructure were inconsistent and did not support that model.',
          approach: 'Defined technical direction for the GraphQL schema registry. Evaluated sync vs async design based on data and delivery constraints; coordinated delivery across backend and QA teams.',
          technicalWork: 'Architected and led delivery of the distributed GraphQL schema registry for customer-specific dynamic APIs. Implemented high-throughput schema ingestion pipeline and API generation. Shipped synchronous design first with monitoring to scale later; used data to show the simpler design was sufficient, with follow-up tickets for future scaling.',
          lessonsLearned: 'Not every system needs Kafka from day one. Implementing monitoring and using data to validate the simpler sync design avoided over-engineering and accelerated delivery while keeping a path to scale.',
        },
      },
      {
        summary: 'Created internal developer tooling that cut environment setup time from hours to seconds.',
        accordion: {
          situation: 'Environment setup took hours, slowing onboarding and day-to-day iteration for engineers; local database and dependency setup was a major bottleneck.',
          approach: 'Focused on local developer experience and identified the critical path: getting a consistent local DB and dependencies in place so engineers could run and test the stack quickly.',
          technicalWork: 'Built a CLI for local database setup that was adopted across teams. Cut environment setup time from hours to minutes (and in practice to seconds for repeat runs). Improved reliability and consistency of local dev environments.',
          lessonsLearned: 'Developer tooling multiplies team velocity. Investing in local experience and reducing setup time pays off in faster iteration and easier onboarding.',
        },
      },
    ],
  },
  {
    title: 'Senior Software Engineer',
    company: 'Capital One',
    period: 'Previous',
    points: [
      {
        summary: 'Onboarded Canada to a new customer acquisitions platform, securing $20M/year in lost revenue.',
        accordion: {
          situation: 'Capital One needed to launch a new credit card for the Canadian business by inner-sourcing into a U.S.-owned system under strict regulatory deadlines. Missing the deadline would have meant inability to offer a card accounting for approximately $20 million in annual revenue. The system was owned by U.S. teams who were fully allocated to a major migration; Canada was low priority.',
          approach: 'Took ownership on the Canadian side: built relationships with U.S. leadership and engineering, gained access to their codebase and processes, and led a team of three engineers and two process managers through planning and delivery. Joined U.S. scrums and aligned on executive and inner-sourcing approval.',
          technicalWork: 'Architected the pathway to onboard Canadian credit card solicitations onto the existing U.S. platform. Modernized solicitation workflows, implemented Golang backend logic to map Canadian business intent to customer profiles, and led development of the React front-end component library (a hackathon POC became the production UI). Delivered CI/CD, observability, and testing. The platform launched on time, met compliance deadlines, and unlocked around $20 million in annual revenue.',
          lessonsLearned: 'Delivering under regulatory and cross-team constraints requires both strong technical execution and relationship-building; inner-sourcing and cross-country alignment are as critical as the code.',
        },
      },
      {
        summary: 'Led cloud migrations for capitalone.ca from on-prem to AWS platform.',
        accordion: {
          situation: 'capitalone.ca ran on-prem; the business needed to move to the cloud-based platform for consistency, scalability, and reliability while keeping customer-facing systems stable.',
          approach: 'Led the migration initiative with a focus on CI/CD, observability, and testing so that customer-facing systems remained reliable during and after the move to AWS.',
          technicalWork: 'Led cloud migrations for capitalone.ca from on-prem to the AWS platform. Built and maintained CI/CD pipelines, observability, and testing for customer-facing systems so that the migration could be executed without degrading reliability.',
          lessonsLearned: 'Cloud migrations succeed when CI/CD and observability are in place from the start; they are not afterthoughts but prerequisites for a safe transition.',
        },
      },
    ],
  },
];

type ProjectTile = {
  id: string;
  title: string;
  briefDescription?: string;
  techLabels: string[];
  overview: string;
  keyChallenges: string[];
  liveSiteUrl: string | null;
  liveSiteDisabled?: boolean;
};

const PROJECT_TILES: ProjectTile[] = [
  {
    id: 'greenfield-apis',
    title: 'GraphQL APIs (Tanium)',
    briefDescription:
      "External GraphQL API gateway that replaced fragmented REST endpoints for Tanium's endpoint management platform. Enables programmatic access to IT/security operations data via streamlined queries, reducing troubleshooting time from hours to minutes for 1,500+ customers.",
    techLabels: ['TypeScript', 'Node.js', 'Golang', 'GraphQL', 'Security', 'gRPC'],
    overview: 'Designed and delivered new external GraphQL APIs at Tanium that replaced fragmented REST endpoints, adopted by 1,500 customers. Reduced support call volumes by 50% and improved deployment stability by giving customers a clear migration path and up-to-date documentation.',
    keyChallenges: [
      'Creating a migration path from legacy REST to modern GraphQL without breaking existing workflows.',
      'Driving cross-functional alignment on API strategy, documentation standards, and schema governance.',
      'Balancing backward compatibility with clean schema design and filtering capabilities.',
    ],
    liveSiteUrl: 'https://help.tanium.com/bundle/ug_gateway_cloud/page/gateway/overview.html',
  },
  {
    id: 'job-hunter',
    title: 'Job Hunter',
    briefDescription:
      'Job application management platform with AI-powered job matching, automated job fetching from popular boards, and an agent that ranks matches by personal preferences. Custom tools, database ops, and email integration; evolving into an MCP service.',
    techLabels: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'OpenAI'],
    overview: 'Job application management platform with AI-powered job matching, automated job fetching from popular boards, and an agent that ranks matches by personal preferences. Custom tools, database ops, and email integration; evolving into an MCP service.',
    keyChallenges: [
      'Integrating multiple job boards and normalizing data for consistent matching.',
      'Designing an agent that ranks jobs by personal preferences with explainable results.',
      'Evolving custom tools and workflows into a reusable MCP service for AI agents.',
    ],
    liveSiteUrl: '#',
    liveSiteDisabled: true,
  },
  {
    id: 'schema-registry',
    title: 'GraphQL Schema Registry (Nacelle)',
    briefDescription:
      "Nacelle's GraphQL APIs enable streamlined and expressive data queries and resource mutations while optimizing network efficiency. The schema registry delivers customer-specific dynamic APIs—Storefront GraphQL for normalized e-commerce data and Admin GraphQL for management—so merchants scale without dedicated engineering support.",
    techLabels: ['GraphQL', 'Node.js', 'TypeScript', 'CLI', 'Data pipelines'],
    overview: 'Architected and led delivery of a distributed GraphQL schema registry for customer-specific dynamic APIs at Nacelle. High-throughput schema ingestion pipeline and developer tooling enabled customers to scale without dedicated engineering support.',
    keyChallenges: [
      'Choosing sync vs async design: used data and monitoring to ship synchronous first with a path to scale later.',
      'Building a high-throughput schema ingestion pipeline that stayed reliable under load.',
      'Coordinating delivery across backend and QA teams while defining technical direction for the registry.',
    ],
    liveSiteUrl: 'https://docs.nacelle.com/reference/api-reference',
  },
  {
    id: 'canada-platform',
    title: 'Canadian Credit Card Platform (Capital One)',
    briefDescription:
      'Internal tooling to onboard Canada to a new cloud-based credit card acquisition platform by inner-sourcing into a U.S.-owned system. Secured ~$20M/year in revenue, met regulatory deadlines, and modernized solicitation workflows with Golang backend and React component library.',
    techLabels: ['Golang', 'React', 'CI/CD', 'Observability', 'AWS'],
    overview: 'Led the engineering effort to onboard Canada to a new cloud-based credit card management platform by inner-sourcing into a U.S.-owned system. Met strict regulatory deadlines and secured approximately $20M/year in revenue. Architected the pathway, built Golang backend for Canadian business intent, and led the React front-end component library.',
    keyChallenges: [
      'Gaining alignment and inner-sourcing approval with U.S. teams who were fully allocated to a major migration.',
      'Mapping Canadian business intent to customer profiles and existing U.S. platform with Go backend and React UI.',
      'Delivering on a fixed regulatory deadline with cross-country coordination and a small Canadian-side team.',
    ],
    liveSiteUrl: null,
  },
];

const SKILLS_GROUPS = [
  {
    name: 'Backend',
    items: [
      { name: 'Node.js', percent: 95 },
      { name: 'Go', percent: 80 },
      { name: 'Java', percent: 75 },
      { name: 'Python', percent: 75 },
    ],
  },
  {
    name: 'Frontend',
    items: [
      { name: 'React', percent: 80 },
      { name: 'JavaScript/ES6', percent: 95 },
      { name: 'TypeScript', percent: 90 },
      { name: 'CSS/SCSS', percent: 70 },
    ],
  },
  {
    name: 'DevOps & Cloud',
    items: [
      { name: 'AWS', percent: 90 },
      { name: 'Docker', percent: 90 },
      { name: 'CI/CD', percent: 88 },
      { name: 'OAuth Integration', percent: 80 },
    ],
  },
  {
    name: 'AI',
    items: [
      { name: 'MCP Services', percent: 70 },
      { name: 'Langchain', percent: 75 },
    ],
  },
];

const HOBBIES = [
  {
    title: 'Car Enthusiast',
    summary: 'High-performance automotive engineering inspires my approach to software optimization - precision, speed, and cutting-edge innovation.',
    detail: 'Performance optimization in automotive engineering directly influences my approach to writing efficient code.',
  },
  {
    title: 'Food Lover',
    summary: 'Complex ingredients meets strategic cooking techniques to deliver dishes that meet the demands of sophisticated palates and children alike.',
    detail: 'Choosing the right ingredients, learning new cooking techniques, and continuous improvement from consumer (family) feedback enhances my ability to plan, design, and improve systems at a high level.',
  },
  {
    title: 'DIY',
    summary: 'Building rather than buying ready-made solutions unlocks new capabilities and skills that pay dividends in the long-run.',
    detail: 'Fixing car engine failures, dishwasher motors, electrical outlet gremlins, mysterious water leaks keeps my analytical and problem solving skills sharp for coding challenges.',
  },
];

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
      <div className="flex flex-wrap gap-2 mb-4">
        {project.techLabels.map((label) => (
          <span
            key={label}
            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 dark:bg-primary-900/50 text-primary-800 dark:text-primary-200"
          >
            {label}
          </span>
        ))}
      </div>
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
              <div>
                <span className="font-semibold text-gray-800 block mb-0.5">Technologies Used</span>
                <div className="flex flex-wrap gap-2 mt-1">
                  {project.techLabels.map((label) => (
                    <span
                      key={label}
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-600 text-gray-800 dark:text-gray-200"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
              {project.liveSiteDisabled ? (
                <button
                  type="button"
                  disabled
                  aria-disabled
                  className="inline-block mt-3 btn-primary text-center opacity-50 cursor-not-allowed"
                >
                  Visit Live Site (Coming soon)
                </button>
              ) : project.liveSiteUrl ? (
                <a
                  href={project.liveSiteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-3 btn-primary text-center"
                >
                  Visit Live Site
                </a>
              ) : null}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

type FitCheckResult = {
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
      const response = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...formData, company: '' }),
      });
      if (!response.ok) throw new Error('Failed to send message');
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
            API Specialist & Backend-focused Full-Stack Web Developer
          </p>
          <div className="max-w-3xl mx-auto">
            <p className="text-lg text-gray-700 dark:text-gray-300 leading-relaxed">
              Building APIs and distributed systems for intelligent AI agents, MCP services, and vanilla SaaS systems. From highly tuned workflow optimized APIs and scalable ingestion pipelines to chat bots and custom MCP services - crafting the future of AI-powered web experiences.
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
          Architecting intelligent systems with security-first approach
        </p>
        <p className="text-gray-700 dark:text-gray-300 leading-relaxed mb-10 max-w-3xl mx-auto">
          I am a backend-focused full stack engineer specializing in APIs and integrations for web applications, with extensive hands-on experience in building public interfaces and designing scalable systems in various domains including IT/security, e-commerce, and finance. I have a growing interest in AI and am working towards building expertise around MCP architectures and intelligent agents. My background spans both backend and frontend development, with a consistent focus on user-friendly, robust interfaces and data security as a primary concern.
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
          {ABOUT_SKILLS.map((item) => (
            <div key={item.label} className="card">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-2">{item.label}</h3>
              <ProgressBar percent={item.percent} />
              <span className="text-sm text-gray-600 dark:text-gray-400 mt-1 block">{item.percent}%</span>
            </div>
          ))}
        </div>

        <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-4">Experience</h3>
        <div className="space-y-6">
          {EXPERIENCE.map((job) => (
            <div key={`${job.company}-${job.title}`} className="card">
              <h4 className="text-lg font-semibold text-gray-900 dark:text-white">{job.title}</h4>
              <p className="text-primary-600 dark:text-primary-400 font-medium">{job.company} — {job.period}</p>
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
                {group.items.map((item) => (
                  <div key={item.name}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-medium text-gray-800 dark:text-gray-200">{item.name}</span>
                      {item.percent != null && <span className="text-sm text-gray-600 dark:text-gray-400">{item.percent}%</span>}
                    </div>
                    <ProgressBar percent={item.percent} />
                  </div>
                ))}
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
          Paste a job description and I&apos;ll give you an honest assessment of how Ray&apos;s experience aligns—or doesn&apos;t.
        </p>

        <form onSubmit={handleFitcheckSubmit} className="max-w-3xl mx-auto mb-8">
          <label htmlFor="fitcheck-job" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Job Description
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
              <p className="text-gray-700 dark:text-gray-300 flex items-center gap-2">
                <svg className="w-5 h-5 shrink-0 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                <a href="mailto:ray.manguino@gmail.com" className="text-primary-600 dark:text-primary-400 hover:underline">ray.manguino@gmail.com</a>
              </p>
              <p className="text-gray-700 dark:text-gray-300 mt-2 flex items-center gap-2">
                <svg className="w-5 h-5 shrink-0 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
                </svg>
                +1 (905) 782-1768
              </p>
              <p className="text-gray-700 dark:text-gray-300 mt-2 flex items-center gap-2">
                <svg className="w-5 h-5 shrink-0 text-primary-600 dark:text-primary-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                Caledon, ON
              </p>
            </div>
            <div className="card">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Social Links</h3>
              <div className="flex flex-col gap-2">
                <a href="https://github.com/raymanguino" target="_blank" rel="noopener noreferrer" className="text-primary-600 dark:text-primary-400 hover:underline inline-flex items-center gap-2">
                  <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path fillRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" clipRule="evenodd" />
                  </svg>
                  Github
                </a>
                <a href="https://linkedin.com/in/raymanguino" target="_blank" rel="noopener noreferrer" className="text-primary-600 dark:text-primary-400 hover:underline inline-flex items-center gap-2">
                  <svg className="w-5 h-5 shrink-0" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433c-1.144 0-2.063-.926-2.063-2.065 0-1.138.92-2.063 2.063-2.063 1.14 0 2.064.925 2.064 2.063 0 1.139-.925 2.065-2.064 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
                  </svg>
                  LinkedIn
                </a>
              </div>
            </div>
            <div className="card">
              <h3 className="text-lg font-bold text-gray-900 dark:text-white mb-4">Resume</h3>
              <a
                href={`${import.meta.env.VITE_API_URL || '/api'}/resume`}
                download="ray.manguino.pdf"
                className="text-primary-600 dark:text-primary-400 hover:underline inline-flex items-center gap-2"
              >
                <svg className="w-5 h-5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                </svg>
                Download Ray&apos;s resume
              </a>
            </div>
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

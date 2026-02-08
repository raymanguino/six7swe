import { useState, useEffect, useRef, useCallback } from 'react';

export type SectionId = 'home' | 'about' | 'projects' | 'skills' | 'hobbies' | 'contacts';

const ABOUT_SKILLS = [
  { label: 'AI & MCP Systems', percent: 75 },
  { label: 'Backend Development', percent: 100 },
  { label: 'Frontend Development', percent: 75 },
  { label: 'Team Leadership', percent: 85 },
  { label: 'API & Data Security', percent: 100 },
];

const TODO_ACCORDION = {
  situation: 'todo',
  approach: 'todo',
  technicalWork: 'todo',
  lessonsLearned: 'todo',
} as const;

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
        accordion: TODO_ACCORDION,
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
        accordion: TODO_ACCORDION,
      },
      {
        summary: 'Created internal developer tooling that cut environment setup time from hours to seconds.',
        accordion: TODO_ACCORDION,
      },
    ],
  },
  {
    title: 'Senior Software Engineer',
    company: 'Capital One',
    period: 'Previous',
    points: [
      {
        summary: 'Onboarded Canada to a new customer acquisitions platform, securing $20mil/year in lost revenue.',
        accordion: TODO_ACCORDION,
      },
      {
        summary: 'Led cloud migrations for capitalone.ca from on-prem to AWS platform.',
        accordion: TODO_ACCORDION,
      },
    ],
  },
];

type ProjectTile = {
  id: string;
  title: string;
  techLabels: string[];
  overview: string;
  keyChallenges: string[];
  liveSiteUrl: string | null;
};

const PROJECT_TILES: ProjectTile[] = [
  {
    id: 'greenfield-apis',
    title: 'New Greenfield APIs - Patch GraphQL APIs',
    techLabels: ['TypeScript', 'Node.js', 'Golang', 'GraphQL', 'Security', 'gRPC'],
    overview: 'todo',
    keyChallenges: ['todo', 'todo', 'todo'],
    liveSiteUrl: 'https://help.tanium.com/bundle/ug_gateway_cloud/page/gateway/overview.html',
  },
  {
    id: 'project-two',
    title: 'Project Two',
    techLabels: ['todo'],
    overview: 'todo',
    keyChallenges: ['todo', 'todo', 'todo'],
    liveSiteUrl: null,
  },
  {
    id: 'project-three',
    title: 'Project Three',
    techLabels: ['todo'],
    overview: 'todo',
    keyChallenges: ['todo', 'todo', 'todo'],
    liveSiteUrl: null,
  },
  {
    id: 'project-four',
    title: 'Project Four',
    techLabels: ['todo'],
    overview: 'todo',
    keyChallenges: ['todo', 'todo', 'todo'],
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
  if (percent == null) return <span className="text-sm text-gray-500">—</span>;
  return (
    <div className="w-full bg-gray-200 rounded-full h-2">
      <div
        className="bg-primary-600 h-2 rounded-full transition-all duration-500"
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
          className="text-left font-medium text-gray-700 hover:text-primary-600 flex items-start gap-2 group"
        >
          <span className="flex-shrink-0 mt-0.5 w-4 h-4 rounded-full bg-gray-300 group-hover:bg-primary-400 flex items-center justify-center text-white text-xs">
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
            <div className="ml-6 pl-2 border-l-2 border-primary-200 space-y-3 text-sm text-gray-600">
              <div>
                <span className="font-semibold text-gray-800 block mb-0.5">Situation</span>
                <p>{accordion.situation}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 block mb-0.5">Approach</span>
                <p>{accordion.approach}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 block mb-0.5">Technical work</span>
                <p>{accordion.technicalWork}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 block mb-0.5">Lessons learned</span>
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
    <div className="card border border-transparent hover:border-primary-200 transition-shadow hover:shadow-lg">
      <h3 className="text-xl font-semibold text-gray-900 mb-3">{project.title}</h3>
      <div className="flex flex-wrap gap-2 mb-4">
        {project.techLabels.map((label) => (
          <span
            key={label}
            className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-primary-100 text-primary-800"
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
          className="text-left font-medium text-gray-700 hover:text-primary-600 flex items-center gap-2 group"
        >
          <span className="flex-shrink-0 w-4 h-4 rounded-full bg-gray-300 group-hover:bg-primary-400 flex items-center justify-center text-white text-xs">
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
            <div className="ml-6 pl-2 border-l-2 border-primary-200 space-y-3 text-sm text-gray-600">
              <div>
                <span className="font-semibold text-gray-800 block mb-0.5">Project Overview</span>
                <p>{project.overview}</p>
              </div>
              <div>
                <span className="font-semibold text-gray-800 block mb-0.5">Key Challenges</span>
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
                      className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800"
                    >
                      {label}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
      {project.liveSiteUrl && (
        <a
          href={project.liveSiteUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-block mt-4 btn-primary text-center"
        >
          Visit Live Site
        </a>
      )}
    </div>
  );
}

export default function Landing({ onSectionChange }: LandingProps) {
  const [formData, setFormData] = useState({ name: '', email: '', message: '' });
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'success' | 'error'>('idle');
  const [expandedAccordion, setExpandedAccordion] = useState<string | null>(null);
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(null);

  const sectionRefs = useRef<Record<SectionId, HTMLElement | null>>({
    home: null,
    about: null,
    projects: null,
    skills: null,
    hobbies: null,
    contacts: null,
  });

  const allSectionIds: SectionId[] = ['home', 'about', 'projects', 'skills', 'hobbies', 'contacts'];

  useEffect(() => {
    const hash = window.location.hash.slice(1) as SectionId | '';
    if (hash && allSectionIds.includes(hash)) {
      const el = document.getElementById(hash);
      if (el) requestAnimationFrame(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    }
  }, []);

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
          <p className="text-xl md:text-2xl text-gray-700 mb-4">My name is Ray Manguino ...</p>
          <p className="text-lg text-primary-600 font-semibold mb-6">
            API Specialist & Backend-focused Full-Stack Web Developer
          </p>
          <div className="max-w-3xl mx-auto">
            <p className="text-lg text-gray-700 leading-relaxed">
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
        <h2 className="text-2xl font-semibold text-gray-800 mb-2 text-center">About Me</h2>
        <p className="text-center text-gray-600 mb-2 max-w-2xl mx-auto">
          Architecting intelligent systems with security-first approach
        </p>
        <p className="text-gray-700 leading-relaxed mb-10 max-w-3xl mx-auto">
          I am a backend-focused full stack engineer specializing in APIs and integrations for web applications, with extensive hands-on experience in building public interfaces and designing scalable systems in various domains including IT/security, e-commerce, and finance. I have a growing interest in AI and am working towards building expertise around MCP architectures and intelligent agents. My background spans both backend and frontend development, with a consistent focus on user-friendly, robust interfaces and data security as a primary concern.
        </p>

        <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-12">
          {ABOUT_SKILLS.map((item) => (
            <div key={item.label} className="card">
              <h3 className="font-semibold text-gray-900 mb-2">{item.label}</h3>
              <ProgressBar percent={item.percent} />
              <span className="text-sm text-gray-600 mt-1 block">{item.percent}%</span>
            </div>
          ))}
        </div>

        <h3 className="text-xl font-bold text-gray-900 mb-4">Experience</h3>
        <div className="space-y-6">
          {EXPERIENCE.map((job) => (
            <div key={`${job.company}-${job.title}`} className="card">
              <h4 className="text-lg font-semibold text-gray-900">{job.title}</h4>
              <p className="text-primary-600 font-medium">{job.company} — {job.period}</p>
              <ul className="mt-3 space-y-4 text-gray-700">
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
        <h2 className="text-2xl font-semibold text-gray-800 mb-8 text-center">Latest Projects</h2>
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
        <h2 className="text-2xl font-semibold text-gray-800 mb-2 text-center">Technical Expertise</h2>
        <p className="text-center text-gray-600 mb-10">Distributed systems and AI-focused technology stack</p>
        <div className="grid md:grid-cols-2 gap-8">
          {SKILLS_GROUPS.map((group) => (
            <div key={group.name} className="card">
              <h3 className="text-lg font-bold text-gray-900 mb-4 border-b border-gray-200 pb-2">{group.name}</h3>
              <div className="space-y-4">
                {group.items.map((item) => (
                  <div key={item.name}>
                    <div className="flex justify-between items-center mb-1">
                      <span className="font-medium text-gray-800">{item.name}</span>
                      {item.percent != null && <span className="text-sm text-gray-600">{item.percent}%</span>}
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
        <h2 className="text-2xl font-semibold text-gray-800 mb-4 text-center">Life Beyond Code</h2>
        <p className="text-center text-gray-600 mb-8 max-w-2xl mx-auto">
          Welcome to my hobbies! Each passion tells a story of precision, creativity, and problem solving.
        </p>
        <div className="grid md:grid-cols-3 gap-6">
          {HOBBIES.map((hobby) => (
            <div key={hobby.title} className="card">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">{hobby.title}</h3>
              <p className="text-gray-600 mb-4">{hobby.summary}</p>
              <p className="text-sm text-gray-700 italic border-l-2 border-primary-200 pl-3">{hobby.detail}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Contact.json */}
      <section
        id="contacts"
        ref={(el) => { sectionRefs.current.contacts = el; }}
        className="scroll-mt-24"
      >
        <h2 className="text-2xl font-semibold text-gray-800 mb-2 text-center">Let's Work Together</h2>
        <p className="text-center text-gray-600 mb-8">Ready to bring your ideas to life</p>
        <p className="text-center text-gray-700 mb-10 max-w-xl mx-auto">
          I'm always excited to work and collaborate with amazing people. Let's create something extraordinary together.
        </p>

        <div className="grid md:grid-cols-2 gap-8 max-w-5xl mx-auto">
          <div className="space-y-6">
            <div className="card">
              <h3 className="text-lg font-bold text-gray-900 mb-4">Get In Touch</h3>
              <p className="text-gray-700">
                <a href="mailto:ray.manguino@gmail.com" className="text-primary-600 hover:underline">ray.manguino@gmail.com</a>
              </p>
              <p className="text-gray-700 mt-2">+1 905 782 1768</p>
              <p className="text-gray-700 mt-2">Caledon, ON</p>
            </div>
            <div className="card">
              <h3 className="text-lg font-bold text-gray-900 mb-4">Social Links</h3>
              <div className="flex flex-col gap-2">
                <a href="https://github.com/raymanguino" target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline">Github</a>
                <a href="https://linkedin.com/in/raymanguino" target="_blank" rel="noopener noreferrer" className="text-primary-600 hover:underline">LinkedIn</a>
              </div>
            </div>
          </div>
          <div className="card">
            <h3 className="text-lg font-bold text-gray-900 mb-4">Send Message</h3>
            <form onSubmit={handleContactSubmit} className="space-y-4">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">Your Name</label>
                <input
                  type="text"
                  id="name"
                  name="name"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">Your Email</label>
                <input
                  type="email"
                  id="email"
                  name="email"
                  value={formData.email}
                  onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                  required
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              <div>
                <label htmlFor="message" className="block text-sm font-medium text-gray-700 mb-1">Your Message</label>
                <textarea
                  id="message"
                  name="message"
                  value={formData.message}
                  onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                  required
                  rows={5}
                  className="w-full border border-gray-300 rounded-lg px-3 py-2 resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
                />
              </div>
              {submitStatus === 'success' && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3">
                  <p className="text-green-800 text-sm">Thank you! Your message has been sent successfully.</p>
                </div>
              )}
              {submitStatus === 'error' && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3">
                  <p className="text-red-800 text-sm">Failed to send message. Please try again later.</p>
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
    </div>
  );
}

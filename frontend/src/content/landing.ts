// Static landing-page content. Edit by hand; there is no runtime content source.

export const ABOUT_STRENGTH_COLUMNS = [
  {
    title: 'Strong',
    icon: 'check',
    iconClass: 'text-green-500',
    items: [
      'Platform & Infrastructure',
      'API Design & Versioning',
      'Technical Strategy',
      'Developer Experience',
      'Cross-functional Leadership',
      'Technical Debt Cleanup',
    ],
  },
  {
    title: 'Moderate',
    icon: 'circle',
    iconClass: 'border-yellow-500',
    items: ['AI & MCP Architectures', 'Security & Compliance', 'Team Building'],
  },
  {
    title: 'Currently Building',
    icon: 'tools',
    iconClass: 'text-primary-600 dark:text-primary-400',
    items: ['RAG Systems', 'Eval Pipelines', 'Edge AI Deployment'],
  },
];

export type AccordionContent = {
  situation: string;
  approach: string;
  technicalWork: string;
  lessonsLearned: string;
};

export const EXPERIENCE: Array<{
  title: string;
  company: string;
  period: string;
  points: Array<{ summary: string; accordion: AccordionContent }>;
}> = [
  {
    title: 'Senior Software Engineer',
    company: 'Tanium',
    period: '2024 - 2025',
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
    period: '2022 - 2023',
    points: [
      {
        summary: 'Architected and delivered API layer services to provide dynamically generated GraphQL endpoints for improved user experiences.',
        accordion: {
          situation: 'Customers needed dynamically generated, customer-specific GraphQL APIs to scale without dedicated engineering support; existing APIs and data infrastructure were inconsistent and did not support that model.',
          approach: 'Defined technical direction for the GraphQL schema registry. Evaluated sync vs. async design based on data and delivery constraints; coordinated delivery across backend and QA teams.',
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
    period: '2017 - 2021',
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

export type ProjectTile = {
  id: string;
  title: string;
  briefDescription?: string;
  techLabels: string[];
  overview: string;
  keyChallenges: string[];
  liveSiteUrl: string | null;
  liveSiteDisabled?: boolean;
};

export const PROJECT_TILES: ProjectTile[] = [
  {
    id: 'mission-control',
    title: 'Mission Control',
    briefDescription:
      'Agent orchestration platform that coordinates specialized AI workers for software project delivery, from approval to deployment, with integrated task workflows and quality control.',
    techLabels: ['MCP', 'Webhooks', 'TypeScript', 'Node.js', 'AI Agents'],
    overview:
      'Mission Control is a tailnet-native API platform that creates, manages, and coordinates multi-agent workflows for software development. It standardizes webhook events and a unified MCP tool interface. The system provides automated project decomposition, task routing, and progress tracking while maintaining a consistent agent communication architecture.',
    keyChallenges: [
      'Building reliable webhooks across different agent runtimes while maintaining proper event sequencing.',
      'Designing workflows that handle async task completion without losing project context.',
      'Creating an MCP interface that enables agent collaboration while enforcing quality gates.',
    ],
    liveSiteUrl: '#',
    liveSiteDisabled: true,
  },
  {
    id: 'portfolio',
    title: 'Portfolio',
    briefDescription:
      'A portfolio site that loads profile, projects, skills, and resume content from a custom MCP service, serves resume assets, and includes a floating chat assistant that answers using that portfolio and resume context.',
    techLabels: ['React', 'TypeScript', 'Vite', 'Fastify', 'MCP', 'PostgreSQL'],
    overview:
      'A full-stack TypeScript portfolio app: the React/Vite SPA loads profile, projects, skills, experience, and contact from a Fastify API backed by a custom MCP service, with resume PDFs and extra content sections served from the backend. A built-in chat widget calls the API so visitors can ask questions about your work using an assistant grounded on stored portfolio and resume context.',
    keyChallenges: [
      'The portfolio API must serve the same shape from PostgreSQL or optional MCP without pushing that complexity into the frontend.',
      'The chat assistant needs enough resume and portfolio context to answer well, without oversized prompts or leaking internal-only details.',
      'Resume and asset URLs must stay correct and fresh across static files, storage, and caching so downloads don\'t break or go stale after updates.',
    ],
    liveSiteUrl: '#',
    liveSiteDisabled: true,
  },
];

export type SkillLevel = 'expert' | 'advanced' | 'intermediate';

export const SKILL_LEVEL_CONFIG: Record<SkillLevel, { label: string; dotClass: string }> = {
  expert: { label: 'Expert', dotClass: 'bg-green-500' },
  advanced: { label: 'Proficient', dotClass: 'bg-yellow-500' },
  intermediate: { label: 'Familiar', dotClass: 'bg-orange-500' },
};

export const SKILLS_GROUPS = [
  {
    name: 'Backend',
    items: [
      { name: 'Node.js', percent: 95, level: 'expert' as SkillLevel },
      { name: 'PostgreSQL', percent: 88, level: 'advanced' as SkillLevel },
      { name: 'Go', percent: 83, level: 'advanced' as SkillLevel },
      { name: 'Python', percent: 70, level: 'intermediate' as SkillLevel },
    ],
  },
  {
    name: 'Frontend',
    items: [
      { name: 'JavaScript/ES6', percent: 95, level: 'expert' as SkillLevel },
      { name: 'TypeScript', percent: 90, level: 'expert' as SkillLevel },
      { name: 'React', percent: 80, level: 'advanced' as SkillLevel },
      { name: 'CSS/SCSS', percent: 70, level: 'intermediate' as SkillLevel },
    ],
  },
  {
    name: 'DevOps & Cloud',
    items: [
      { name: 'AWS', percent: 92, level: 'expert' as SkillLevel },
      { name: 'Docker', percent: 88, level: 'expert' as SkillLevel },
      { name: 'CI/CD', percent: 85, level: 'advanced' as SkillLevel },
      { name: 'Terraform', percent: 75, level: 'advanced' as SkillLevel },
    ],
  },
  {
    name: 'AI',
    items: [
      { name: 'Prompt Craft', percent: 80, level: 'advanced' as SkillLevel },
      { name: 'Context/Intent/Spec Engineering', percent: 70, level: 'intermediate' as SkillLevel },
      { name: 'MiniMax Agents SDK', percent: 70, level: 'intermediate' as SkillLevel },
      { name: 'OpenClaw', percent: 70, level: 'intermediate' as SkillLevel },
    ],
  },
];

export const HOBBIES = [
  {
    title: 'Car Enthusiast',
    summary: 'High-performance automotive engineering inspires my approach to software optimization - precision, speed, and cutting-edge innovation.',
    detail: 'Tuning my car and refining my driving skills require research, experimentation, and iterative improvement, shaping how I approach problem-solving in fast-moving environments.',
  },
  {
    title: 'Food Lover',
    summary: 'Ingredients planning and logistics combined with strategic cooking techniques to deliver dishes that meet the demands of various palates and dietary needs.',
    detail: 'Planning meals under real-world constraints—cost, time, and whether either kid will actually eat it—strengthens my system-level design skills.',
  },
  {
    title: 'DIY Champion',
    summary: 'Building rather than buying ready-made solutions unlocks new capabilities and skills that pay dividends in the long-run. Plus, it\'s cheaper!',
    detail: 'Hands-on problem solving builds transferable skills I apply to software development, balancing short-term needs with long-term results.',
  },
];

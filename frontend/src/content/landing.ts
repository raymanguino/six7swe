// Static landing-page content. Edit by hand; there is no runtime content source.

export type StrengthColumn = {
  title: string;
  icon: 'check' | 'circle' | 'tools';
  iconClass: string;
  items: string[];
};

export const ABOUT_STRENGTH_COLUMNS: StrengthColumn[] = [
  {
    title: 'Strong',
    icon: 'check',
    iconClass: 'text-green-500',
    items: [
      'API Design & Versioning',
      'Distributed Systems',
      'Platform & Infrastructure',
      'Technical Strategy',
      'Developer Experience',
      'Cross-functional Leadership',
    ],
  },
  {
    title: 'Moderate',
    icon: 'circle',
    iconClass: 'border-yellow-500',
    items: ['RAG & LLM Evals', 'AI & MCP Architectures', 'Security & Compliance', 'Team Building'],
  },
  {
    title: 'Currently Building',
    icon: 'tools',
    iconClass: 'text-primary-600 dark:text-primary-400',
    items: ['Review Agent Calibration', 'Kubernetes (CKAD)', 'Amazon Web Services (SAA)'],
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
    title: 'AI Engineer (Independent)',
    company: 'six7swe',
    period: '2025 - Present',
    points: [
      {
        summary: 'Built a RAG knowledge service on pgvector that serves this site\'s chat and a job-matching engine, validated by a blind-judged A/B: higher accuracy (9.2 vs 8.5/10) with ~40% less context per question.',
        accordion: {
          situation: 'The portfolio chat stuffed hand-seeded tables into every prompt. Answers went stale whenever my background changed, and the job matcher had no shared source of truth.',
          approach: 'Built one separate, private-network service that both consumers read from, and measured before switching: an A/B eval with a blind LLM judge compared stuffed and retrieved context on the same questions, prompt and model.',
          technicalWork: 'Fastify, Drizzle and Zod over Postgres with pgvector (HNSW). Heading-aware chunking, crash-safe ingestion with status in the database, and a corpus version counter that keys chat caches and triggers job-match rescoring. Fixed an HNSW post-filter recall bug with pgvector 0.8 iterative scans. An evolving eval set re-runs on every corpus change and flags knowledge gaps, and a stateless MCP endpoint exposes the same retrieval to Claude clients.',
          lessonsLearned: 'The bigger risk was stale context, not missed retrieval. Every large win for retrieval came from information the stuffed prompt didn\'t have, so freshness deserved as much design attention as ranking.',
        },
      },
      {
        summary: 'Built an LLM agent that reviews every pull request as a required status check, with prompt-injection defences enforced in code and precision tracked per prompt version before it may block merges.',
        accordion: {
          situation: 'I wanted automated review on every PR, but the PR title, description and diff are written by the author, the one input an attacker fully controls, and a reviewer that hallucinates or can be steered is worse than none.',
          approach: 'Gated with a required status check instead of a bot approval: a job-scoped token instead of a long-lived credential, a named failure instead of a silent missing approval, and support for Dependabot PRs. The agent can never approve; a human always owns that.',
          technicalWork: 'Runs in GitHub Actions on the base branch and never executes PR code. Untrusted input is delimited with its delimiters escaped, injection attempts are pinned to a non-blocking severity in code, and the gate is computed by pure functions, never taken from the model. Findings outside the diff are discarded, and failures fail closed. Every run logs structured stats, and I judge findings by hand in a versioned verdicts file.',
          lessonsLearned: 'Treat an LLM reviewer like a classifier. It stays in comment-only mode until its measured precision reaches the target, because the data, not my confidence in the prompt, decides when it may block.',
        },
      },
      {
        summary: 'Designed a Claude Code workflow of subagents and skills that takes a GitHub epic to reviewed pull requests, with human approval at every plan, push and merge; agents write nearly all of the platform\'s code.',
        accordion: {
          situation: 'Coding agents had become reliable enough to write production code, which moved the leverage from writing code to specifying and reviewing it, as long as the agents stayed contained.',
          approach: 'Kept the orchestrator thin: it plans, delegates and summarizes, while each subagent starts with a fresh, focused context and an explicit tool allowlist. When output is wrong, I fix the spec or prompt, not the code, so the correction carries into every later run.',
          technicalWork: 'Orchestrator skills plan an epic\'s sub-issues into dependency waves; implementers work in parallel in isolated git worktrees; read-only reviewer and security-auditor agents check each change, with at most two fix rounds. A separate bot account opens one PR per issue and I approve it, and its token cannot modify CI workflows.',
          lessonsLearned: 'Give agents near-total autonomy in implementation and very little in direction. Approval gates belong at the points that are hard to undo: the plan, the push and the merge.',
        },
      },
    ],
  },
  {
    title: 'Senior Software Engineer',
    company: 'Tanium',
    period: '2024 - 2025',
    points: [
      {
        summary: 'Designed and delivered new GraphQL APIs adopted by 1,500+ enterprise customers, replacing fragmented REST calls, cutting troubleshooting time from ~1 hour to minutes, and halving that category of support tickets.',
        accordion: {
          situation: 'Two overlapping APIs did the same job and each was broken differently: the legacy API filtered correctly but its patch state went stale, while the newer API kept state current but couldn\'t filter correctly. Customers built brittle workarounds, and support volume kept climbing.',
          approach: 'Ran working sessions with customers and support instead of redesigning blind, and found the root cause was the filtering behavior, not the API shape. Ruled out a third API, which would have added confusion, in favor of one shared filtering object.',
          technicalWork: 'Built a unified filtering object on a hybrid TypeScript/Node.js and Go backend, with its schema pinned to one commit and both services generating types from it so the contract couldn\'t drift. Shipped it as a non-breaking change, rewrote the public and internal docs, and worked with support to move customers across.',
          lessonsLearned: 'Ticket data tells you where the pain is, not why. Designing for how customers think, rather than how the backend is modeled, is what made adoption possible.',
        },
      },
      {
        summary: 'Rebuilt monitoring and alerting in four weeks, cutting alert noise by 70%; the alerting patterns were adopted as a baseline template by two other teams.',
        accordion: {
          situation: 'On-call engineers were burning hours per incident on noisy alerts funneled into a single Slack thread. Real incidents got buried under false positives, and the team had stopped trusting the on-call process.',
          approach: 'Made the business case to win sprint capacity against feature work: the cost of slow incident response was higher than the cost of fixing it. Scoped ruthlessly to the signals that mattered for our incident patterns, error rate and p99 latency.',
          technicalWork: 'Built Grafana/Prometheus instrumentation and alert rules, classified jobs by priority, routed alerts to separate channels by priority, and set paging rules so only high-priority issues paged after hours. Tuned thresholds and ran a dry-fire with the on-call rotation before rolling to production.',
          lessonsLearned: 'Ship the 80% version fast and let real on-call data tell you what to add next. Next time I would run the dry-fire in week one: it caught two misconfigured thresholds.',
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
        summary: 'Architected and led a team of four delivering a federated GraphQL schema registry for ~300 merchants, cutting read latency under load from several seconds to 50–100 ms.',
        accordion: {
          situation: 'The shared GraphQL API couldn\'t serve the largest merchants\' custom data, so they built costly one-off workarounds. A registry would sit on the critical path of every storefront request, so latency and consistency were paramount.',
          approach: 'Settled the Kafka-versus-synchronous debate with data: I instrumented schema size, count and update frequency, which showed small, rare updates where consistency mattered more than throughput. Chose a central Redis cache over CDN or in-process caching after analyzing the read-heavy access pattern.',
          technicalWork: 'Took the registry from a hackathon prototype to production with versioned, idempotent synchronous writes and a high-availability Redis cache sharded by merchant id (cache-aside, invalidate on write, database fallback). When beta added a third-party dependency to the write path, I moved writes to a Kafka pipeline with stepped backoff and a dead-letter queue.',
          lessonsLearned: 'Not every system needs Kafka from day one. Measuring first avoided over-engineering, and when the data changed, so did the design.',
        },
      },
      {
        summary: 'Built a CLI that cut local database setup from hours to minutes, adopted organically across engineering, including a VS Code extension contributed by other engineers.',
        accordion: {
          situation: 'Reproducing production issues locally took hours of manual steps, tribal knowledge and inconsistent data snapshots, slowing debugging, onboarding and customer-facing fixes.',
          approach: 'Interviewed engineers about where setup broke down, and compared a shared staging database, better-documented SQL dumps and full automation. Only automation scaled and stayed maintainable.',
          technicalWork: 'Built a CLI that loads the schema and seeds a minimal but realistic dataset into local Postgres in one command, with flags for advanced scenarios. Socialized it with demos and docs rather than mandating it, then iterated on feedback.',
          lessonsLearned: 'Developer tooling multiplies team velocity, and tools that solve a real pain spread on their own when you demo them instead of mandating them.',
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
        summary: 'Led Canada\'s launch on a U.S.-owned credit card platform under a hard regulatory deadline, protecting $20M+ in annual revenue.',
        accordion: {
          situation: 'Capital One needed to launch a new credit card for the Canadian business by inner-sourcing into a U.S.-owned system under strict regulatory deadlines. Missing the deadline would have meant inability to offer a card accounting for approximately $20 million in annual revenue. The system was owned by U.S. teams who were fully allocated to a major migration; Canada was low priority.',
          approach: 'Took ownership on the Canadian side: built architecture diagrams, a roadmap and a risk analysis that won U.S. leadership sign-off, then led a team of three engineers and two process managers embedded in the U.S. team\'s scrums.',
          technicalWork: 'Architected the pathway to onboard Canadian credit card solicitations onto the existing U.S. platform. Implemented Golang backend logic on AWS to map Canadian business intent to customer profiles, and led development of the React front-end component library (a hackathon POC became the production UI). Delivered CI/CD, observability, and testing, and shipped within the six-month regulatory window.',
          lessonsLearned: 'The technical work was the easier half; earning cooperation from a team with every reason to deprioritize us was the real lift. Come with a proposal, not a request.',
        },
      },
      {
        summary: 'Owned the Terraform modules for migrating capitalone.ca from on-prem to AWS, and built a serverless alarm filter that stopped false pages without hiding real outages.',
        accordion: {
          situation: 'capitalone.ca ran on-prem and needed to move to AWS without degrading a customer-facing site. After the move, an unidentified source requesting nonexistent files kept tripping the 404 alarm and paging the team overnight.',
          approach: 'Served the static site from a private S3 bucket through CloudFront, so only the distribution could reach the content. For the noisy alarm, I couldn\'t get the traffic blocked at the gateway and wouldn\'t raise the threshold, so I filtered on what the 404s were for.',
          technicalWork: 'Provisioned S3, CloudFront with Origin Access Control, a Lambda@Edge directory-index rewrite, CloudWatch alarms, SNS and IAM in Terraform. Routed the alarm through SNS to a Lambda that checked the 404s against an allowlist of real endpoints, paging only for real breakages and logging every suppressed alarm.',
          lessonsLearned: 'When you can\'t fix a problem at its source, fix it at the boundary you own, and keep the evidence so the decision stays auditable.',
        },
      },
    ],
  },
];

export type ProjectTile = {
  id: string;
  title: string;
  briefDescription?: string;
  overview: string;
  keyChallenges: string[];
};

export const PROJECT_TILES: ProjectTile[] = [
  {
    id: 'knowledge-service',
    title: 'Knowledge Service (RAG)',
    briefDescription:
      'The private RAG service behind this site: it powers the chat assistant, the job fit checker and the resume download, and the job hunter scores postings against the same knowledge.',
    overview:
      'A separate Fastify deployable in the six7swe monorepo that ingests resumes and background documents, chunks them by heading, embeds them with OpenAI into pgvector, and serves retrieval over REST on a private network and over MCP for Claude clients. A corpus version counter keeps every consumer consistent, and an evolving eval set re-runs on every corpus change to flag knowledge gaps.',
    keyChallenges: [
      'Ingestion is crash-safe and never serves partial data: status lives in the database, unfinished work is re-queued on boot, and a failed re-ingest stops serving that document.',
      'pgvector\'s HNSW index filtered after its candidate search, so queries could miss matching chunks; iterative scans in relaxed order fixed the recall.',
      'Caches and job-match scores are keyed by corpus version, so new documents reach every consumer without explicit invalidation.',
      'The service stays on a private network: the public site reaches it only through the backend, and each caller type has its own key.',
    ],
  },
  {
    id: 'qa-agent',
    title: 'PR Review Agent',
    briefDescription:
      'An LLM reviewer that checks every pull request in GitHub Actions and reports through a required status check, built to treat the PR as untrusted input.',
    overview:
      'The agent reviews each PR\'s bounded diff for correctness, type, architecture, security and error-handling defects, and posts one review bound to the head commit. The model returns findings only; pure, unit-tested code decides the gate. It runs in comment-only mode while I calibrate its precision against hand-judged verdicts.',
    keyChallenges: [
      'Prompt injection from the PR author is defended in code, not just the prompt: escaped delimiters, forged-notice detection, and steering attempts pinned below the blocking severity.',
      'Hallucinated findings are filtered against the diff, and the drop rate is measured per run.',
      'API errors, schema failures and truncated responses fail closed, so a broken agent never reads as a clean PR.',
    ],
  },
  {
    id: 'agent-workflow',
    title: 'Agentic Dev Workflow',
    briefDescription:
      'Custom Claude Code subagents and skills that turn a GitHub epic into reviewed pull requests, with my approval at every checkpoint.',
    overview:
      'An orchestrator skill plans an epic\'s sub-issues into dependency waves and delegates each issue to an implementer working in its own git worktree. Read-only reviewer and security-auditor agents check every change, and a bot account opens one PR per issue for me to approve. Agents now write nearly all of six7swe\'s code.',
    keyChallenges: [
      'Least privilege per agent: reviewers can only read, and implementers edit only inside their own worktree and never push.',
      'Keeping the orchestrator\'s context small across many issues by making it plan and delegate, never write code.',
      'Bounded loops: at most three issues per wave and two review-fix rounds, with anything unresolved reported rather than retried.',
    ],
  },
  {
    id: 'mission-control',
    title: 'Mission Control',
    briefDescription:
      'An earlier agent orchestration platform that coordinates specialized AI workers for software project delivery over a self-hosted MCP gateway.',
    overview:
      'Mission Control is a tailnet-native API platform that creates, manages, and coordinates multi-agent workflows for software development. It standardizes webhook events and a unified MCP tool interface, authenticates agents with API keys, and runs generated code in sandboxed containers. Events route through OpenClaw, a Raspberry Pi gateway on a private Tailscale network.',
    keyChallenges: [
      'Building reliable webhooks across different agent runtimes while maintaining proper event sequencing.',
      'Designing workflows that handle async task completion without losing project context.',
      'Creating an MCP interface that enables agent collaboration while enforcing quality gates.',
    ],
  },
];

export type SkillLevel = 'expert' | 'advanced' | 'intermediate';

export const SKILL_LEVEL_CONFIG: Record<SkillLevel, { label: string; dotClass: string }> = {
  expert: { label: 'Expert', dotClass: 'bg-green-500' },
  advanced: { label: 'Proficient', dotClass: 'bg-yellow-500' },
  intermediate: { label: 'Familiar', dotClass: 'bg-orange-500' },
};

export type SkillItem = { name: string; percent: number; level: SkillLevel };
export type SkillGroup = { name: string; items: SkillItem[] };

export const SKILLS_GROUPS: SkillGroup[] = [
  {
    name: 'Backend',
    items: [
      { name: 'Node.js', percent: 95, level: 'expert' },
      { name: 'GraphQL', percent: 92, level: 'expert' },
      { name: 'PostgreSQL', percent: 88, level: 'advanced' },
      { name: 'Go', percent: 83, level: 'advanced' },
      { name: 'Kafka & Redis', percent: 80, level: 'advanced' },
    ],
  },
  {
    name: 'Frontend',
    items: [
      { name: 'JavaScript/ES6', percent: 95, level: 'expert' },
      { name: 'TypeScript', percent: 90, level: 'expert' },
      { name: 'React', percent: 80, level: 'advanced' },
      { name: 'CSS/SCSS', percent: 70, level: 'intermediate' },
    ],
  },
  {
    name: 'DevOps & Cloud',
    items: [
      { name: 'AWS', percent: 92, level: 'expert' },
      { name: 'Docker', percent: 88, level: 'expert' },
      { name: 'CI/CD', percent: 85, level: 'advanced' },
      { name: 'Terraform', percent: 75, level: 'advanced' },
      { name: 'Kubernetes', percent: 75, level: 'advanced' },
    ],
  },
  {
    name: 'AI',
    items: [
      { name: 'Claude Code Agent Workflows', percent: 85, level: 'advanced' },
      { name: 'RAG & pgvector', percent: 82, level: 'advanced' },
      { name: 'MCP Servers', percent: 82, level: 'advanced' },
      { name: 'LLM Evals', percent: 78, level: 'advanced' },
      { name: 'Prompt-Injection Defence', percent: 72, level: 'intermediate' },
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

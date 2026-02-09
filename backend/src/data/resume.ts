// Resume data for AI context and display
export const resumeData = {
  name: 'Ray Manguino',
  title: 'API Specialist & Backend-focused Full-Stack Web Developer',
  email: 'ray.manguino@gmail.com',
  linkedin: 'https://linkedin.com/in/raymanguino',
  github: 'https://github.com/raymanguino',

  summary: `Backend-focused full-stack engineer specializing in APIs and integrations for web applications, with extensive hands-on experience building public interfaces and designing scalable systems in IT/security, e-commerce, and finance. Security-first approach; growing interest in AI, MCP architectures, and intelligent agents. Background spans backend and frontend with a consistent focus on user-friendly, robust interfaces and data security.`,

  skills: [
    'Backend: Go, Node.js, Java, TypeScript',
    'Databases: PostgreSQL, SQL Server',
    'APIs: GraphQL, REST, schema design, documentation',
    'Frontend: React, TypeScript',
    'Cloud & infra: AWS, Docker, CI/CD, observability',
    'System design: distributed systems, data pipelines, ETL',
  ],

  experience: [
    {
      title: 'Software Engineer',
      company: 'Tanium',
      period: 'Recent',
      description: 'Led design and development of new external GraphQL APIs that replaced fragmented REST endpoints; reduced support call volumes 50%, improved deployment stability. Built monitoring and alerting (50% faster response, 70% less noise). Tuned Postgres and refactored backend services (40% better query times). Drove cross-functional API strategy, documentation standards, schema governance.',
    },
    {
      title: 'Software Engineer',
      company: 'Nacelle',
      period: 'Previous',
      description: 'Architected and led delivery of distributed GraphQL schema registry for customer-specific dynamic APIs. High-throughput schema ingestion pipeline, developer tooling (CLI for local DB setup adopted across teams). Improved API reliability and latency; enabled customers to scale without dedicated engineering support.',
    },
    {
      title: 'Software Engineer',
      company: 'Capital One',
      period: 'Previous',
      description: 'Led engineering effort to onboard Canada to new cloud-based credit card management platform; architected pathway, Golang backend for Canadian business intent, React front-end component library. Delivered on regulatory deadline; secured ~$20M/year in revenue. Built CI/CD, observability, and testing for customer-facing systems.',
    },
    {
      title: 'Full-stack Engineer',
      company: 'IBM',
      period: 'Earlier',
      description: 'Led design and development of data ETL for heterogeneous data import, REST API endpoints to expose backend features, and enhancements to web UI report generation. Tech stack: C#, JavaScript, HTML, CSS, SQL Server.',
    },
  ],

  projects: [
    {
      name: 'Job Hunter',
      description: 'Job application management platform with AI-powered job matching, automated job fetching from popular boards, and an agent that ranks matches by personal preferences (custom tools, database ops, email; evolving into MCP service).',
      technologies: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'OpenAI'],
    },
  ],

  // Full resume text for AI context
  fullResumeText: `
Ray Manguino - API Specialist & Backend-focused Full-Stack Web Developer

SUMMARY
Backend-focused full-stack engineer specializing in APIs and integrations for web applications. Extensive experience building public interfaces and designing scalable systems in IT/security, e-commerce, and finance. Security-first approach; growing interest in AI, MCP architectures, and intelligent agents. Background spans backend and frontend with focus on robust interfaces and data security.

SKILLS
- Backend: Go, Node.js, Java, TypeScript
- Databases: PostgreSQL, SQL Server
- APIs: GraphQL, REST, schema design, documentation
- Frontend: React, TypeScript
- Cloud & infra: AWS, Docker, CI/CD, observability
- System design: distributed systems, data pipelines, ETL

EXPERIENCE
Tanium - Software Engineer
- Led design and development of new external GraphQL APIs; replaced fragmented REST; 50% reduction in support call volumes and deployment errors
- Built monitoring and alerting (50% faster response, 70% less noise); tuned Postgres and refactored backend (40% better query times, reduced page load)
- Drove cross-functional alignment on API strategy, documentation standards, schema governance, monitoring

Nacelle - Software Engineer
- Architected and led delivery of distributed GraphQL schema registry for customer-specific dynamic APIs
- High-throughput schema ingestion pipeline; developer CLI (local DB setup from hours to minutes, adopted across teams)
- Improved API reliability and latency; customers could scale without dedicated engineering support

Capital One - Software Engineer
- Led engineering to onboard Canada to new cloud-based credit card platform; ~$20M/year revenue secured; met regulatory deadline
- Architected pathway, Golang backend, React component library; CI/CD, observability, testing

IBM - Full-stack Engineer
- Led data ETL, REST API endpoints, web UI report tooling. Tech: C#, JavaScript, SQL Server

PROJECTS
Job Hunter - AI-powered job application platform: finds and filters open jobs, agent ranks by preferences, custom tools and MCP service in progress.
  `,
};

// Resume data extracted from PDF - update with actual resume content
export const resumeData = {
  name: 'Ray Manguino',
  title: 'Software Engineer',
  email: 'ray@example.com',
  linkedin: 'https://linkedin.com/in/raymanguino',
  github: 'https://github.com/raymanguino',
  
  summary: `Passionate software engineer with expertise in full-stack development, AI integration, and system architecture. 
  I build scalable, maintainable applications that solve real-world problems. Always learning, always building, always improving.`,
  
  skills: [
    'Full-Stack Development',
    'React',
    'TypeScript',
    'Node.js',
    'PostgreSQL',
    'AI & Machine Learning',
    'OpenAI APIs',
    'LangChain',
    'System Architecture',
    'Cloud Platforms (Railway, AWS)',
    'Docker',
    'RESTful APIs',
    'Microservices',
  ],
  
  experience: [
    {
      title: 'Software Engineer',
      company: 'Current/Previous Company',
      period: '202X - Present',
      description: 'Built scalable web applications and integrated AI capabilities.',
    },
  ],
  
  projects: [
    {
      name: 'Job Hunter',
      description: 'A comprehensive job application management platform with AI-powered job matching, automated job fetching, and intelligent profile-to-job scoring.',
      technologies: ['React', 'TypeScript', 'Node.js', 'PostgreSQL', 'OpenAI'],
    },
  ],
  
  // Full resume text for AI context (update with actual resume content)
  fullResumeText: `
    Ray Manguino - Software Engineer
    
    SUMMARY
    Passionate software engineer with expertise in full-stack development, AI integration, and system architecture. 
    I build scalable, maintainable applications that solve real-world problems.
    
    SKILLS
    - Full-Stack Development: React, TypeScript, Node.js, PostgreSQL
    - AI & Machine Learning: OpenAI APIs, LangChain, ML frameworks
    - System Architecture: Cloud platforms, Docker, microservices
    - Database Design: PostgreSQL, database optimization
    - APIs: RESTful API design and implementation
    
    EXPERIENCE
    Software Engineer - Current/Previous Company
    - Built scalable web applications with modern frameworks
    - Integrated AI capabilities into applications
    - Designed robust and scalable systems
    
    PROJECTS
    Job Hunter - A comprehensive job application management platform with AI-powered job matching, 
    automated job fetching from multiple sources, and intelligent profile-to-job scoring algorithms.
  `,
};

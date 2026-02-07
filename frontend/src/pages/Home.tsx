import { useState } from 'react';
import JobMatcher from '../components/JobMatcher';

interface Highlight {
  id: string;
  title: string;
  summary: string;
  details: string;
}

const highlights: Highlight[] = [
  {
    id: '1',
    title: 'Full-Stack Development',
    summary: 'Expert in building scalable web applications with modern frameworks',
    details: 'Proficient in React, TypeScript, Node.js, and PostgreSQL. Experienced in building RESTful APIs, real-time applications, and microservices architectures. Strong understanding of software engineering principles and best practices.',
  },
  {
    id: '2',
    title: 'AI & Machine Learning',
    summary: 'Experience integrating AI capabilities into applications',
    details: 'Worked with OpenAI APIs, LangChain, and various ML frameworks. Built intelligent systems for job matching, content generation, and data analysis. Understanding of prompt engineering and AI agent architectures.',
  },
  {
    id: '3',
    title: 'System Architecture',
    summary: 'Designing robust and scalable systems',
    details: 'Experience with cloud platforms (Railway, AWS), containerization (Docker), and database design. Strong focus on performance optimization, security best practices, and maintainable code architecture.',
  },
];

const achievements = [
  {
    id: '1',
    title: 'Job Application Platform',
    summary: 'Built a comprehensive job tracking and matching system',
    details: 'Developed a full-stack application for managing job applications with AI-powered job matching, automated job fetching from multiple sources, and intelligent profile-to-job scoring algorithms.',
  },
  {
    id: '2',
    title: 'Open Source Contributions',
    summary: 'Active contributor to open source projects',
    details: 'Contributed to various open source projects, improving documentation, fixing bugs, and adding new features. Passionate about giving back to the developer community.',
  },
];

export default function Home() {
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id);
  };

  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl">
      {/* Intro Section */}
      <section className="mb-16">
        <div className="text-center mb-8">
          <h1 className="text-5xl font-bold text-gray-900 mb-4">
            Ray Manguino
          </h1>
          <p className="text-2xl text-gray-600 mb-6">
            Software Engineer
          </p>
          <div className="max-w-3xl mx-auto">
            <p className="text-lg text-gray-700 leading-relaxed">
              Passionate software engineer with expertise in full-stack development, 
              AI integration, and system architecture. I build scalable, maintainable 
              applications that solve real-world problems. Always learning, always building, 
              always improving.
            </p>
          </div>
        </div>
      </section>

      {/* Highlights Section */}
      <section className="mb-16">
        <h2 className="text-3xl font-bold text-gray-900 mb-8 text-center">
          Core Skills & Expertise
        </h2>
        <div className="grid md:grid-cols-3 gap-6">
          {highlights.map((highlight) => (
            <div
              key={highlight.id}
              className="card cursor-pointer hover:shadow-lg transition-shadow"
              onClick={() => toggleExpand(highlight.id)}
            >
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                {highlight.title}
              </h3>
              <p className="text-gray-600 mb-4">{highlight.summary}</p>
              {expandedId === highlight.id && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <p className="text-gray-700">{highlight.details}</p>
                </div>
              )}
              <div className="text-primary-600 text-sm font-medium mt-2">
                {expandedId === highlight.id ? 'Click to collapse' : 'Click to learn more'}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Achievements Section */}
      <section className="mb-16">
        <h2 className="text-3xl font-bold text-gray-900 mb-8 text-center">
          Key Achievements
        </h2>
        <div className="space-y-6">
          {achievements.map((achievement) => (
            <div
              key={achievement.id}
              className="card cursor-pointer hover:shadow-lg transition-shadow"
              onClick={() => toggleExpand(`achievement-${achievement.id}`)}
            >
              <h3 className="text-xl font-semibold text-gray-900 mb-2">
                {achievement.title}
              </h3>
              <p className="text-gray-600 mb-4">{achievement.summary}</p>
              {expandedId === `achievement-${achievement.id}` && (
                <div className="mt-4 pt-4 border-t border-gray-200">
                  <p className="text-gray-700">{achievement.details}</p>
                </div>
              )}
              <div className="text-primary-600 text-sm font-medium mt-2">
                {expandedId === `achievement-${achievement.id}` ? 'Click to collapse' : 'Click to learn more'}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* Job Matcher Section */}
      <section className="mb-16">
        <JobMatcher />
      </section>
    </div>
  );
}

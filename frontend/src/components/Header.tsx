import { useEffect, useState } from 'react';
import type { SectionId } from '../pages/Landing';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'home', label: 'Welcome.init()' },
  { id: 'about', label: 'About.go' },
  { id: 'projects', label: 'Projects.ai' },
  { id: 'skills', label: 'Skills.js' },
  { id: 'hobbies', label: 'Hobbies.fun' },
  { id: 'contacts', label: 'Contact.json' },
];

interface HeaderProps {
  activeSection: SectionId;
}

const SCROLL_THRESHOLD = 20;

export default function Header({ activeSection }: HeaderProps) {
  const [atTop, setAtTop] = useState(true);

  useEffect(() => {
    const handleScroll = () => setAtTop(window.scrollY < SCROLL_THRESHOLD);
    handleScroll(); // Initialize
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  const handleNavClick = (e: React.MouseEvent<HTMLAnchorElement>, sectionId: SectionId) => {
    e.preventDefault();
    const el = document.getElementById(sectionId);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <header className="fixed top-0 left-0 right-0 bg-white shadow-md z-50 font-mono">
      <nav className="container mx-auto max-w-screen-2xl pl-6 pr-6 py-4">
        <div className="flex flex-col items-start gap-2">
          <div
            className={`w-full overflow-hidden transition-all duration-300 ease-in-out flex items-center justify-between ${
              atTop ? 'max-h-12 opacity-100' : 'max-h-0 opacity-0'
            }`}
          >
            <a
              href="#home"
              onClick={(e) => handleNavClick(e, 'home')}
              className="text-2xl font-bold text-primary-600 hover:text-primary-700 shrink-0"
            >
              {'>_ raymanguino.sh ~ main'}
            </a>
            <div className="flex items-center gap-2 text-sm text-gray-600 shrink-0">
              <span>Open to Senior+ roles at Series A-D companies</span>
              <span
                className="relative inline-block w-2.5 h-2.5 rounded-full bg-emerald-400"
                style={{
                  boxShadow:
                    '0 0 6px 2px rgba(52, 211, 153, 0.5), 0 0 12px 4px rgba(52, 211, 153, 0.25), inset 0 0 4px 1px rgba(255, 255, 255, 0.4)',
                }}
                aria-hidden
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2 justify-start items-center">
            {SECTIONS.map(({ id, label }) => (
              <a
                key={id}
                href={`#${id}`}
                onClick={(e) => handleNavClick(e, id)}
                className={`px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                  activeSection === id
                    ? 'text-primary-600 bg-primary-50'
                    : 'text-gray-700 hover:text-primary-600 hover:bg-gray-100'
                }`}
              >
                {label}
              </a>
            ))}
          </div>
        </div>
      </nav>
    </header>
  );
}

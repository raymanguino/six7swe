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
      <nav className="container mx-auto max-w-screen-2xl pl-6 pr-0 py-4">
        <div className="flex flex-col items-start gap-2">
          <div
            className={`overflow-hidden transition-all duration-300 ease-in-out ${
              atTop ? 'max-h-12 opacity-100' : 'max-h-0 opacity-0'
            }`}
          >
            <a
              href="#home"
              onClick={(e) => handleNavClick(e, 'home')}
              className="text-2xl font-bold text-primary-600 hover:text-primary-700 block"
            >
              {'>_ raymanguino.sh ~ main'}
            </a>
          </div>
          <div className="flex flex-wrap gap-2 justify-start">
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

import { useEffect, useState } from 'react';
import { useTheme } from '../contexts/ThemeContext';
import type { SectionId } from '../pages/Landing';

const SECTIONS: { id: SectionId; label: string }[] = [
  { id: 'home', label: 'Welcome.init()' },
  { id: 'about', label: 'About.go' },
  { id: 'projects', label: 'Projects.ai' },
  { id: 'skills', label: 'Skills.js' },
  { id: 'hobbies', label: 'Hobbies.fun' },
  { id: 'fitcheck', label: 'FitCheck.dll' },
  { id: 'contacts', label: 'Contact.json' },
];

interface HeaderProps {
  activeSection: SectionId;
}

const SCROLL_THRESHOLD = 20;

export default function Header({ activeSection }: HeaderProps) {
  const [atTop, setAtTop] = useState(true);
  const { theme, toggleTheme } = useTheme();

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
    <header className="fixed top-0 left-0 right-0 bg-white dark:bg-gray-800 shadow-md z-50 font-mono">
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
              className="text-2xl font-bold text-primary-600 hover:text-primary-700 dark:text-primary-300 dark:hover:text-primary-200 shrink-0"
            >
              {'>_ raymanguino.dev ~ main'}
            </a>
            <div className="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 shrink-0">
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
                    ? 'text-primary-600 bg-primary-50 dark:text-primary-200 dark:bg-primary-900/50'
                    : 'text-gray-700 hover:text-primary-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-primary-300 dark:hover:bg-gray-700'
                }`}
              >
                {label}
              </a>
            ))}
            <button
              type="button"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                toggleTheme();
              }}
              aria-label={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
              className="ml-2 p-2 rounded-md text-gray-600 hover:text-primary-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-primary-300 dark:hover:bg-gray-700 transition-colors"
            >
              {theme === 'dark' ? (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z" />
                </svg>
              )}
            </button>
          </div>
        </div>
      </nav>
    </header>
  );
}

import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useTheme } from './contexts/ThemeContext';
import Header from './components/Header';
import ChatAssistant from './components/ChatAssistant';
import Landing from './pages/Landing';
import type { SectionId } from './pages/Landing';

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('home');
  const { theme } = useTheme();

  return (
    <div className={theme === 'dark' ? 'dark' : ''} suppressHydrationWarning>
      <div className="min-h-screen flex flex-col bg-gradient-to-r from-gray-50 to-gray-200/70 dark:from-gray-800/90 dark:to-gray-900">
        <Header activeSection={activeSection} />
        <main className="flex-1 pt-16">
          <Routes>
            <Route path="/" element={<Landing onSectionChange={setActiveSection} />} />
            <Route path="/work" element={<Navigate to="/#projects" replace />} />
            <Route path="/contacts" element={<Navigate to="/#contacts" replace />} />
          </Routes>
        </main>
        <ChatAssistant />
      </div>
    </div>
  );
}

export default App;

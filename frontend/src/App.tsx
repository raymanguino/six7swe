import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import Header from './components/Header';
import ChatAssistant from './components/ChatAssistant';
import Landing from './pages/Landing';
import type { SectionId } from './pages/Landing';

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('home');

  return (
    <div className="min-h-screen flex flex-col">
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
  );
}

export default App;

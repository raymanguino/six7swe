import { useState } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useTheme } from './contexts/ThemeContext';
import Header from './components/Header';
import ChatAssistant from './components/ChatAssistant';
import Landing from './pages/Landing';
import type { SectionId } from './pages/Landing';
import { AuthProvider } from './contexts/AuthContext';
import HunterLayout from './pages/hunter/HunterLayout';
import Login from './pages/hunter/Login';
import RequireAuth from './pages/hunter/RequireAuth';
import ProfileList from './pages/hunter/ProfileList';
import ProfileDetail from './pages/hunter/ProfileDetail';
import ProfileEditor from './pages/hunter/ProfileEditor';

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('home');
  const { theme } = useTheme();

  return (
    <div className={theme === 'dark' ? 'dark' : ''} suppressHydrationWarning>
      <AuthProvider>
        <div className="min-h-screen flex flex-col bg-gradient-to-r from-gray-50 to-gray-200/70 dark:from-gray-800/90 dark:to-gray-900">
          <Routes>
            {/* Job-hunter: a signed-in tool, separate from the public site. */}
            <Route path="/hunter/login" element={<Login />} />
            <Route
              path="/hunter"
              element={
                <RequireAuth>
                  <HunterLayout />
                </RequireAuth>
              }
            >
              <Route index element={<Navigate to="/hunter/profiles" replace />} />
              <Route path="profiles" element={<ProfileList />} />
              <Route path="profiles/:profileId" element={<ProfileDetail />} />
              <Route path="profiles/:profileId/edit" element={<ProfileEditor />} />
            </Route>

            {/* Public portfolio. */}
            <Route
              path="/"
              element={
                <>
                  <Header activeSection={activeSection} />
                  <main className="flex-1 pt-16">
                    <Landing onSectionChange={setActiveSection} />
                  </main>
                  <ChatAssistant />
                </>
              }
            />
            <Route path="/work" element={<Navigate to="/#projects" replace />} />
            <Route path="/contacts" element={<Navigate to="/#contacts" replace />} />
          </Routes>
        </div>
      </AuthProvider>
    </div>
  );
}

export default App;

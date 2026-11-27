import { lazy, Suspense, useState } from 'react';
import { Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { useTheme } from './contexts/ThemeContext';
import Header from './components/Header';
import ChatAssistant from './components/ChatAssistant';
import Landing from './pages/Landing';
import NotFound from './pages/NotFound';
import type { SectionId } from './pages/Landing';

// The job hunter, and supabase-js with it, is a separate chunk loaded on /hunter/*.
const HunterApp = lazy(() => import('./pages/hunter/HunterApp'));
const HunterLayout = lazy(() => import('./pages/hunter/HunterLayout'));
const Login = lazy(() => import('./pages/hunter/Login'));
const RequireAuth = lazy(() => import('./pages/hunter/RequireAuth'));
const ProfileList = lazy(() => import('./pages/hunter/ProfileList'));
const ProfileDetail = lazy(() => import('./pages/hunter/ProfileDetail'));
const ProfileEditor = lazy(() => import('./pages/hunter/ProfileEditor'));
const KnowledgePage = lazy(() => import('./pages/hunter/knowledge/KnowledgePage'));

/** Header, content and chat assistant shared by every public-site page. */
function PublicShell({ activeSection }: { activeSection: SectionId }) {
  return (
    <>
      <Header activeSection={activeSection} />
      <main className="flex-1 pt-16">
        <Outlet />
      </main>
      <ChatAssistant />
    </>
  );
}

function App() {
  const [activeSection, setActiveSection] = useState<SectionId>('home');
  const { theme } = useTheme();

  return (
    <div className={theme === 'dark' ? 'dark' : ''} suppressHydrationWarning>
      <div className="min-h-screen flex flex-col bg-gradient-to-r from-gray-50 to-gray-200/70 dark:from-gray-800/90 dark:to-gray-900">
        <Routes>
          {/*
            Job-hunter: a signed-in tool, separate from the public site. HunterApp
            owns the AuthProvider and the Suspense boundary for the lazy pages.
          */}
          <Route path="/hunter" element={<HunterAppBoundary />}>
            <Route path="login" element={<Login />} />
            <Route
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
              {/* Owner only: the page redirects anyone else, and the API answers 403. */}
              <Route path="knowledge" element={<KnowledgePage />} />
            </Route>
          </Route>

          {/* Public portfolio. */}
          <Route element={<PublicShell activeSection={activeSection} />}>
            <Route path="/" element={<Landing onSectionChange={setActiveSection} />} />
            <Route path="/work" element={<Navigate to="/#projects" replace />} />
            <Route path="/contacts" element={<Navigate to="/#contacts" replace />} />
            {/* Anything else, including unknown /hunter/* paths. */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </div>
    </div>
  );
}

/** Suspense boundary for the lazy HunterApp chunk itself. */
function HunterAppBoundary() {
  return (
    <Suspense fallback={null}>
      <HunterApp />
    </Suspense>
  );
}

export default App;

import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { AuthProvider } from '../../contexts/AuthContext';
import HunterLayout from './HunterLayout';
import RequireAuth from './RequireAuth';

/**
 * Root of every /hunter/* route. It is loaded lazily, so the Supabase client
 * and the job-hunter pages stay out of the public landing page bundle; the
 * public shell never creates a Supabase client.
 */
export default function HunterApp() {
  return (
    <AuthProvider>
      <Suspense fallback={<HunterLoading />}>
        <Outlet />
      </Suspense>
    </AuthProvider>
  );
}

/** The signed-in layout, bundled in this chunk so only the pages load afterwards. */
export function HunterShell() {
  return (
    <RequireAuth>
      <HunterLayout />
    </RequireAuth>
  );
}

function HunterLoading() {
  return <div className="p-8 text-center text-gray-500">Loading...</div>;
}

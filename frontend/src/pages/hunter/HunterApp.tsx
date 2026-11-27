import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';
import { AuthProvider } from '../../contexts/AuthContext';

/**
 * Root of every /hunter/* route. It is loaded lazily, so the Supabase client
 * and the job-hunter pages stay out of the public landing page bundle; the
 * public shell never creates a Supabase client.
 */
export default function HunterApp() {
  return (
    <AuthProvider>
      <Suspense fallback={null}>
        <Outlet />
      </Suspense>
    </AuthProvider>
  );
}

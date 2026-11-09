import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Blocks the job-hunter routes until a session exists.
 *
 * The API enforces this too; the guard here just avoids rendering a shell
 * that would immediately fail every request.
 */
export default function RequireAuth({ children }: { children: React.ReactNode }) {
  const { session, loading, configured } = useAuth();
  const location = useLocation();

  if (loading) {
    return <div className="p-8 text-center text-gray-500">Loading...</div>;
  }

  if (!configured) {
    return (
      <div className="mx-auto max-w-lg p-8 text-center">
        <h1 className="mb-2 text-xl font-bold text-gray-900 dark:text-white">
          Authentication is not configured
        </h1>
        <p className="text-sm text-gray-600 dark:text-gray-300">
          Set <code className="font-mono">VITE_SUPABASE_URL</code> and{' '}
          <code className="font-mono">VITE_SUPABASE_ANON_KEY</code> to enable the job-hunter.
        </p>
      </div>
    );
  }

  if (!session) {
    return <Navigate to="/hunter/login" replace state={{ from: location }} />;
  }

  return <>{children}</>;
}

import { Link, Outlet, useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';

/**
 * Layout for the job-hunter product.
 *
 * Separate from the public portfolio shell: the portfolio is a read-only
 * visitor experience, the hunter is a signed-in tool.
 */
export default function HunterLayout() {
  const { userEmail, signOut } = useAuth();
  const navigate = useNavigate();

  const handleSignOut = async () => {
    await signOut();
    // react-router 7 returns a promise from `navigate`. The navigation is
    // deliberately not awaited, so the result is marked as ignored.
    void navigate('/hunter/login');
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <header className="border-b border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-800">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900 dark:text-white">Job Hunter</h1>
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Signed in as {userEmail ?? 'unknown'}
            </p>
          </div>
          <nav className="flex items-center gap-4">
            <Link
              to="/hunter/profiles"
              className="text-sm font-medium text-gray-700 hover:text-primary-600 dark:text-gray-200"
            >
              Profiles
            </Link>
            <Link
              to="/"
              className="text-sm font-medium text-gray-700 hover:text-primary-600 dark:text-gray-200"
            >
              Portfolio
            </Link>
            <button
              type="button"
              onClick={handleSignOut}
              className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 transition hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}

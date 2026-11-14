import { Link } from 'react-router-dom';

/** Rendered for any URL that matches no other route. */
export default function NotFound() {
  return (
    <section className="mx-auto flex min-h-[60vh] max-w-xl flex-col items-center justify-center px-4 text-center">
      <title>Page not found</title>
      <meta name="robots" content="noindex" />
      <p className="text-sm font-semibold uppercase tracking-wide text-primary-600 dark:text-primary-300">
        404
      </p>
      <h1 className="mt-2 text-3xl font-bold text-gray-900 dark:text-white">Page not found</h1>
      <p className="mt-3 text-gray-600 dark:text-gray-300">
        The page you are looking for does not exist or may have moved.
      </p>
      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link
          to="/"
          className="btn-primary text-sm font-medium focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          Back to portfolio
        </Link>
        <Link
          to="/hunter/login"
          className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-100 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-700 focus-visible:ring-2 focus-visible:ring-primary-500"
        >
          Job hunter
        </Link>
      </div>
    </section>
  );
}

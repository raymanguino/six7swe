import { useState, useEffect } from 'react';
// import { Link } from 'react-router-dom';
import { apiRequest } from '../utils/api';

interface Job {
  id: number;
  source_id: string;
  source_job_id: string;
  title: string;
  company: string;
  location?: string;
  description?: string;
  url?: string;
  posted_at?: string;
}

export default function Work() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void fetchJobs();
  }, []);

  const fetchJobs = async () => {
    try {
      setLoading(true);
      const response = await fetch('/api/jobs');
      if (!response.ok) {
        throw new Error('Failed to fetch jobs');
      }
      const data = await response.json();
      setJobs(data.jobs || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load jobs');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container mx-auto px-4 py-12 max-w-6xl">
      <h1 className="text-4xl font-bold text-gray-900 mb-8 text-center">
        My Work
      </h1>

      {/* Job Hunter Project */}
      <div className="mb-12">
        <div className="card mb-6">
          <h2 className="text-2xl font-bold text-gray-900 mb-4">Job Hunter</h2>
          <p className="text-gray-600 mb-6">
            A comprehensive job application management platform that helps track job applications,
            matches profiles to job descriptions using AI, and fetches jobs from multiple sources.
          </p>

          {loading && (
            <div className="text-center py-8">
              <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600"></div>
              <p className="mt-2 text-gray-600">Loading jobs...</p>
            </div>
          )}

          {error && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4 mb-6">
              <p className="text-red-800">{error}</p>
            </div>
          )}

          {!loading && !error && (
            <>
              <div className="mb-4">
                <h3 className="text-lg font-semibold text-gray-900 mb-2">
                  Available Jobs ({jobs.length})
                </h3>
                <p className="text-sm text-gray-600">
                  Click on a job to view details
                </p>
              </div>

              {jobs.length === 0 ? (
                <div className="text-center py-8 text-gray-500">
                  No jobs available at the moment.
                </div>
              ) : (
                <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {jobs.map((job) => (
                    <JobCard key={job.id} job={job} />
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function JobCard({ job }: { job: Job }) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [jobDetails, setJobDetails] = useState<Job | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(false);

  const handleClick = async () => {
    if (isExpanded) {
      setIsExpanded(false);
      return;
    }

    setLoadingDetails(true);
    try {
      const data = await apiRequest(`/jobs/${job.source_id}/${job.source_job_id}`) as { job: Job };
      setJobDetails(data.job || null);
    } catch (error) {
      console.error('Failed to fetch job details:', error);
      setJobDetails(null);
    } finally {
      setLoadingDetails(false);
      setIsExpanded(true);
    }
  };

  return (
    <div
      className="border border-gray-200 rounded-lg p-4 hover:shadow-md transition-shadow cursor-pointer"
      onClick={handleClick}
    >
      <h4 className="font-semibold text-gray-900 mb-1">{job.title}</h4>
      <p className="text-sm text-primary-600 mb-2">{job.company}</p>
      {job.location && (
        <p className="text-xs text-gray-500 mb-2">{job.location}</p>
      )}
      {job.posted_at && (
        <p className="text-xs text-gray-400">
          Posted: {new Date(job.posted_at).toLocaleDateString()}
        </p>
      )}

      {isExpanded && (
        <div className="mt-4 pt-4 border-t border-gray-200">
          {loadingDetails ? (
            <div className="text-center py-4">
              <div className="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-primary-600"></div>
            </div>
          ) : jobDetails ? (
            <div className="space-y-2">
              {jobDetails.description && (
                <div>
                  <p className="text-xs font-semibold text-gray-700 mb-1">Description:</p>
                  <p className="text-xs text-gray-600 line-clamp-3">
                    {jobDetails.description}
                  </p>
                </div>
              )}
              {jobDetails.url && (
                <a
                  href={jobDetails.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-primary-600 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  View Original Posting →
                </a>
              )}
            </div>
          ) : (
            <p className="text-xs text-gray-500">No additional details available</p>
          )}
        </div>
      )}

      <div className="mt-2 text-xs text-primary-600">
        {isExpanded ? 'Click to collapse' : 'Click to view details'}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { INPUT_LIMITS } from '../constants';
import { apiRequest } from '../utils/api';

export default function JobMatcher() {
  const [jobDescription, setJobDescription] = useState('');
  const [score, setScore] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [analysis, setAnalysis] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!jobDescription.trim()) return;

    setIsLoading(true);
    setScore(null);
    setAnalysis(null);

    try {
      const data = await apiRequest('/job-match', {
        method: 'POST',
        body: JSON.stringify({ jobDescription }),
      });
      setScore(data.score);
      setAnalysis(data.analysis || null);
    } catch (error) {
      alert('Failed to analyze job description. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-green-600 dark:text-green-400';
    if (score >= 60) return 'text-yellow-600 dark:text-yellow-400';
    return 'text-red-600 dark:text-red-400';
  };

  const getScoreBgColor = (score: number) => {
    if (score >= 80) return 'bg-green-100 dark:bg-green-900/40';
    if (score >= 60) return 'bg-yellow-100 dark:bg-yellow-900/40';
    return 'bg-red-100 dark:bg-red-900/40';
  };

  return (
    <div className="card">
      <h2 className="text-3xl font-bold text-gray-900 dark:text-white mb-6 text-center">
        Job Match Analyzer
      </h2>
      <p className="text-gray-600 dark:text-gray-300 mb-6 text-center">
        Paste a job description below to see how well it matches my skillset
      </p>

      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label htmlFor="jobDescription" className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Job Description
          </label>
          <textarea
            id="jobDescription"
            value={jobDescription}
            onChange={(e) => setJobDescription(e.target.value.slice(0, INPUT_LIMITS.jobDescription))}
            placeholder="Paste the job description here..."
            maxLength={INPUT_LIMITS.jobDescription}
            className="w-full border border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg px-4 py-3 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-primary-500"
            rows={8}
            required
          />
        </div>

        <button
          type="submit"
          disabled={isLoading || !jobDescription.trim()}
          className="w-full btn-primary disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isLoading ? 'Analyzing...' : 'Analyze Match'}
        </button>
      </form>

      {score !== null && (
        <div className="mt-8 pt-8 border-t border-gray-200 dark:border-gray-600">
          <div className="text-center mb-4">
            <div className={`inline-block px-6 py-3 rounded-lg ${getScoreBgColor(score)}`}>
              <div className={`text-4xl font-bold ${getScoreColor(score)}`}>
                {score}%
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">Match Score</div>
            </div>
          </div>

          {analysis && (
            <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
              <h3 className="font-semibold text-gray-900 dark:text-white mb-2">Analysis:</h3>
              <p className="text-gray-700 dark:text-gray-300 whitespace-pre-wrap text-sm">{analysis}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

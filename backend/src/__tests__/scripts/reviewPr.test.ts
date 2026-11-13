import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { REVIEW_MARKER } from '../../domain/qa';

/**
 * Exercises the script end to end with the network stubbed.
 *
 * The script is the seam between the pure decision logic and the two side
 * effects, so the things worth proving are the ones a unit test of the
 * domain cannot: that it posts exactly one review, that the exit code
 * follows the gate outcome and the mode, that the review is bound to the
 * commit the diff was read at, and that a missing variable fails fast
 * without posting anything.
 *
 * A child process is used because the script runs on import. The stub
 * intercepts `fetch` inside that process, so the MiniMax call and the
 * GitHub calls are both recorded.
 */

const SCRIPT = path.join(__dirname, '..', '..', '..', 'scripts', 'review-pr.ts');

/**
 * The local tsx binary.
 *
 * `npx` is not used: it spawns a wrapper process, and the exit status of
 * the wrapper is not the exit status of the script under test. The
 * `.bin/tsx` shell wrapper is not used either, because it is not an
 * executable on Windows. `node --import tsx` runs the same script with the
 * same exit status on every platform.
 */

const STUB = `
const calls = [];
globalThis.fetch = async (url, init) => {
  const target = String(url);
  const method = init && init.method ? init.method : 'GET';
  calls.push({ method, url: target, body: init && init.body ? init.body : null });

  if (target.includes('/pulls/') && !target.includes('/reviews') && !target.includes('/files')) {
    return new Response(JSON.stringify({
      title: 'a pull request',
      body: 'a description',
      head: { sha: globalThis.__HEAD_SHA__ },
    }), { status: 200 });
  }

  if (target.includes('/files')) {
    return new Response(JSON.stringify(globalThis.__FILES__), { status: 200 });
  }

  if (target.includes('/reviews') && method === 'GET') {
    return new Response(JSON.stringify(globalThis.__REVIEWS__), { status: 200 });
  }

  if (target.includes('/dismissals')) {
    return new Response('{}', { status: globalThis.__DISMISS_STATUS__ });
  }

  if (target.includes('/reviews')) {
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }

  if (target.includes('minimax')) {
    return new Response(JSON.stringify({
      choices: [{ message: { content: globalThis.__MODEL_RESPONSE__ } }],
      usage: {
        prompt_tokens: 1200,
        completion_tokens: 900,
        total_tokens: 2100,
        completion_tokens_details: { reasoning_tokens: 700 },
      },
    }), { status: 200 });
  }

  throw new Error('unexpected request: ' + target);
};

process.on('exit', () => {
  process.stdout.write('\\n__CALLS__' + JSON.stringify(calls));
});
`;

const MODEL_RESPONSE = JSON.stringify({
  summary: 'The source change looks fine.',
  findings: [
    {
      severity: 'major',
      file: 'backend/src/index.ts',
      line: 2,
      message: 'The old value is dropped without being used.',
    },
    {
      severity: 'blocker',
      file: 'backend/src/made-up.ts',
      line: 9,
      message: 'A path that is not in the diff.',
    },
  ],
});

/** A response whose only finding blocks the merge. */
const BLOCKING_RESPONSE = JSON.stringify({
  summary: 'The source change breaks the build.',
  findings: [
    {
      severity: 'blocker',
      file: 'backend/src/index.ts',
      line: 2,
      message: 'The old value is dropped without being used.',
    },
  ],
});

interface RecordedCall {
  method: string;
  url: string;
  body: string | null;
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  calls: RecordedCall[];
}

interface RunOptions {
  modelResponse?: string;
  headSha?: string;
  files?: unknown[];
  /** The reviews already on the pull request. */
  reviews?: unknown[];
  /** The HTTP status a dismissal answers with. */
  dismissStatus?: number;
}

/** The changed files the stubbed pull request reports. */
const SOURCE_FILE = {
  filename: 'backend/src/index.ts',
  status: 'modified',
  additions: 2,
  deletions: 1,
  patch: '@@ -1,2 +1,2 @@\n ctx\n-old\n+new',
};

/**
 * The lockfile is a protected path: a pull request that changes it needs
 * a human, whatever the model found.
 */
const LOCKFILE = {
  filename: 'pnpm-lock.yaml',
  status: 'modified',
  additions: 9,
  deletions: 3,
  patch: 'lockfile noise',
};

function runScript(env: Record<string, string>, options: RunOptions = {}): RunResult {
  const stubFile = path.join(__dirname, '__stub.cjs');
  const modelResponse = options.modelResponse ?? MODEL_RESPONSE;
  const headSha = options.headSha ?? 'abc123';
  const files = options.files ?? [SOURCE_FILE, LOCKFILE];
  const reviews = options.reviews ?? [];
  const dismissStatus = options.dismissStatus ?? 200;

  try {
    fs.writeFileSync(
      stubFile,
      `${STUB}\nglobalThis.__MODEL_RESPONSE__ = ${JSON.stringify(modelResponse)};\n` +
        `globalThis.__HEAD_SHA__ = ${JSON.stringify(headSha)};\n` +
        `globalThis.__FILES__ = ${JSON.stringify(files)};\n` +
        `globalThis.__REVIEWS__ = ${JSON.stringify(reviews)};\n` +
        `globalThis.__DISMISS_STATUS__ = ${JSON.stringify(dismissStatus)};\n` +
        `require(${JSON.stringify(SCRIPT)});\n`,
    );

    // `spawnSync` rather than `execFileSync`: the latter returns stderr
    // only when the process fails, and a run that succeeds can still log
    // a warning worth asserting on.
    const child = spawnSync(process.execPath, ['--import', 'tsx', stubFile], {
      encoding: 'utf-8',
      env: childEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const status = child.status ?? 1;
    const stdout = child.stdout ?? '';
    const stderr = child.stderr ?? '';

    const marker = stdout.indexOf('__CALLS__');
    const calls =
      marker >= 0 ? (JSON.parse(stdout.slice(marker + '__CALLS__'.length)) as RecordedCall[]) : [];

    return {
      status,
      stdout: marker >= 0 ? stdout.slice(0, marker) : stdout,
      stderr,
      calls,
    };
  } finally {
    fs.rmSync(stubFile, { force: true });
  }
}

/**
 * The environment for the child process.
 *
 * `NODE_OPTIONS` is dropped: it carries the editor's debug bootloader,
 * which makes the child wait for a debugger that is not there.
 */
function childEnv(env: Record<string, string>): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...process.env, ...env };
  delete merged.NODE_OPTIONS;
  return merged;
}

const BASE_ENV = {
  MINIMAX_API_KEY: 'test-key',
  GITHUB_TOKEN: 'test-token',
  GITHUB_REPOSITORY: 'raymanguino/six7swe',
  PR_NUMBER: '7',
  PR_HEAD_SHA: 'abc123',
  PR_TITLE: 'a pull request',
  PR_DESCRIPTION: 'a description',
};

function reviewPost(result: RunResult): { event?: string; body: string; commit_id?: string } {
  const post = result.calls.find((call) => call.method === 'POST' && call.url.includes('/reviews'));
  return JSON.parse(post?.body ?? '{}') as { event?: string; body: string; commit_id?: string };
}

describe('review-pr script', () => {
  it('posts exactly one review', () => {
    const result = runScript(BASE_ENV);

    const posts = result.calls.filter(
      (call) => call.method === 'POST' && call.url.includes('/reviews'),
    );

    expect(posts).toHaveLength(1);
  });

  it('exits 0 when the gate passes', () => {
    const result = runScript(BASE_ENV);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Gate outcome: pass');
  });

  it('binds the review to the pull request head SHA', () => {
    const result = runScript(BASE_ENV);

    expect(reviewPost(result).commit_id).toBe('abc123');
  });

  it('binds the review to the commit the diff was read at, not the one the workflow was triggered for', () => {
    // The pull request was pushed to while the workflow was running, so
    // the diff and the live head say "def456" and the trigger says
    // "abc123". The review has to describe the code it actually read.
    const result = runScript(BASE_ENV, { headSha: 'def456' });

    expect(reviewPost(result).commit_id).toBe('def456');
    expect(reviewPost(result).body).toContain('def456');
  });

  it('says so when the pull request moved', () => {
    const result = runScript(BASE_ENV, { headSha: 'def456' });

    expect(result.stdout).toContain('The pull request head is now def456');
  });

  it('never sends the lockfile patch to the model', () => {
    const result = runScript(BASE_ENV);

    const modelCall = result.calls.find((call) => call.url.includes('minimax'));
    const body = JSON.parse(modelCall?.body ?? '{}');
    const userMessage = body.messages.find(
      (message: { role: string }) => message.role === 'user',
    ).content;

    expect(userMessage).not.toContain('lockfile noise');
    expect(userMessage).toContain('pnpm-lock.yaml');
  });

  it('never sends the token in a request body', () => {
    const result = runScript(BASE_ENV);

    for (const call of result.calls) {
      expect(call.body ?? '').not.toContain('test-token');
    }
  });

  it('fails fast when the API key is missing and posts nothing', () => {
    const result = runScript({ ...BASE_ENV, MINIMAX_API_KEY: '' });

    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.url.includes('/reviews'))).toHaveLength(0);
  });

  it('fails fast when the pull request number is missing', () => {
    const result = runScript({ ...BASE_ENV, PR_NUMBER: '' });

    expect(result.status).not.toBe(0);
    expect(result.calls.filter((call) => call.url.includes('/reviews'))).toHaveLength(0);
  });

  it('names the missing variable when it fails fast', () => {
    const result = runScript({ ...BASE_ENV, MINIMAX_API_KEY: '' });

    expect(result.stderr).toContain('MINIMAX_API_KEY');
  });

  it('rejects an unknown review mode rather than guessing', () => {
    const result = runScript({ ...BASE_ENV, REVIEW_MODE: 'yolo' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('REVIEW_MODE');
  });
});

describe('the script reports a failed review as a failure', () => {
  it('posts a fail-closed review', () => {
    // A model response that is not valid JSON is a broken review, not a
    // defect in the pull request. The outcome has to be reported as an
    // error rather than as a finding.
    const result = runScript(BASE_ENV, { modelResponse: 'not json at all' });

    const body = reviewPost(result).body;

    expect(body).toContain('fail-closed');
    expect(body).toContain('not a finding about this pull request');
  });

  it('still posts exactly one review', () => {
    const result = runScript(BASE_ENV, { modelResponse: 'not json at all' });

    const posts = result.calls.filter(
      (call) => call.method === 'POST' && call.url.includes('/reviews'),
    );

    expect(posts).toHaveLength(1);
  });

  it('exits 0 in comment-only mode, because the agent is not the gate there', () => {
    const result = runScript(BASE_ENV, { modelResponse: 'not json at all' });

    expect(result.status).toBe(0);
  });

  it('exits 1 in enforce mode, because a broken agent must not look green', () => {
    const result = runScript(
      { ...BASE_ENV, REVIEW_MODE: 'enforce' },
      { modelResponse: 'not json at all' },
    );

    expect(result.status).toBe(1);
  });
});

describe('the script obeys the review mode', () => {
  it('exits 0 on a blocking finding in comment-only mode', () => {
    const result = runScript(BASE_ENV, {
      modelResponse: BLOCKING_RESPONSE,
      files: [SOURCE_FILE],
    });

    expect(result.stdout).toContain('Gate outcome: pass');
    expect(result.status).toBe(0);
  });

  it('posts a plain comment in comment-only mode', () => {
    const result = runScript(BASE_ENV, {
      modelResponse: BLOCKING_RESPONSE,
      files: [SOURCE_FILE],
    });

    expect(reviewPost(result).event).toBe('COMMENT');
  });

  it('exits 1 on a blocking finding in enforce mode', () => {
    const result = runScript(
      { ...BASE_ENV, REVIEW_MODE: 'enforce' },
      { modelResponse: BLOCKING_RESPONSE, files: [SOURCE_FILE] },
    );

    expect(result.stdout).toContain('Gate outcome: fail');
    expect(result.status).toBe(1);
  });

  it('asks for changes in enforce mode', () => {
    // A review's event is fixed once GitHub accepts it, so a review that
    // asks for changes has to be a new review, not an edited comment.
    const result = runScript(
      { ...BASE_ENV, REVIEW_MODE: 'enforce' },
      { modelResponse: BLOCKING_RESPONSE, files: [SOURCE_FILE] },
    );

    expect(reviewPost(result).event).toBe('REQUEST_CHANGES');
  });

  it('says which event it posted', () => {
    const result = runScript(
      { ...BASE_ENV, REVIEW_MODE: 'enforce' },
      { modelResponse: BLOCKING_RESPONSE, files: [SOURCE_FILE] },
    );

    expect(result.stdout).toContain('Posted one REQUEST_CHANGES review');
  });

  it('sends a protected path to a human rather than blocking it itself', () => {
    // A pull request that changes the dependency manifest is changing the
    // thing the agent runs under, so it never gets an automatic decision.
    const result = runScript(
      { ...BASE_ENV, REVIEW_MODE: 'enforce' },
      { modelResponse: BLOCKING_RESPONSE, files: [SOURCE_FILE, LOCKFILE] },
    );

    expect(result.stdout).toContain('Gate outcome: manual-review');
    expect(result.status).toBe(1);
  });

  it('does not ask for changes on a protected path', () => {
    // The agent did not decide that the pull request is wrong, so it must
    // not say so with a request for changes.
    const result = runScript(
      { ...BASE_ENV, REVIEW_MODE: 'enforce' },
      { modelResponse: BLOCKING_RESPONSE, files: [SOURCE_FILE, LOCKFILE] },
    );

    expect(reviewPost(result).event).toBe('COMMENT');
  });
});

describe('the script does not let model output forge the log', () => {
  it('escapes a workflow command in a finding message', () => {
    const forged = JSON.stringify({
      summary: 'Fine.',
      findings: [
        {
          severity: 'minor',
          file: 'backend/src/index.ts',
          line: 2,
          message: '::error title=fake::the check passed',
        },
      ],
    });

    const result = runScript(BASE_ENV, { modelResponse: forged });

    expect(result.stdout).not.toContain('::error');
    expect(result.stdout).toContain('%3A%3A');
  });

  it('keeps a finding message on one line', () => {
    const forged = JSON.stringify({
      summary: 'Fine.',
      findings: [
        {
          severity: 'minor',
          file: 'backend/src/index.ts',
          line: 2,
          message: 'first line\n::add-mask::secret',
        },
      ],
    });

    const result = runScript(BASE_ENV, { modelResponse: forged });

    const findingLines = result.stdout
      .split('\n')
      .filter((line) => line.includes('first line') || line.includes('add-mask'));

    expect(findingLines).toHaveLength(1);
  });
});

describe('the script retires its earlier requests for changes', () => {
  /** A response with nothing to report. */
  const CLEAN_RESPONSE = JSON.stringify({ summary: 'The change looks fine.', findings: [] });

  /** A request for changes the agent posted on an earlier push. */
  const STALE_REQUEST = {
    id: 41,
    body: `${REVIEW_MARKER}\n## QA agent review`,
    user: { login: 'github-actions[bot]' },
    state: 'CHANGES_REQUESTED',
  };

  const ENFORCE_ENV = { ...BASE_ENV, REVIEW_MODE: 'enforce' };

  function dismissals(result: RunResult): RecordedCall[] {
    return result.calls.filter((call) => call.url.includes('/dismissals'));
  }

  it('dismisses the earlier request once the pull request passes', () => {
    const result = runScript(ENFORCE_ENV, {
      modelResponse: CLEAN_RESPONSE,
      files: [SOURCE_FILE],
      reviews: [STALE_REQUEST],
    });

    expect(result.status).toBe(0);
    expect(dismissals(result)).toHaveLength(1);
    expect(dismissals(result)[0].method).toBe('PUT');
    expect(dismissals(result)[0].url).toContain('/reviews/41/dismissals');
    expect(result.stdout).toContain('Dismissed the earlier request for changes (review 41)');
  });

  it('dismisses only after the new verdict is posted', () => {
    // The pull request must never be left without a current verdict.
    const result = runScript(ENFORCE_ENV, {
      modelResponse: CLEAN_RESPONSE,
      files: [SOURCE_FILE],
      reviews: [STALE_REQUEST],
    });

    const postIndex = result.calls.findIndex(
      (call) => call.method === 'POST' && call.url.includes('/reviews'),
    );
    const dismissIndex = result.calls.findIndex((call) => call.url.includes('/dismissals'));

    expect(postIndex).toBeGreaterThanOrEqual(0);
    expect(dismissIndex).toBeGreaterThan(postIndex);
  });

  it('posts the passing verdict as a new review rather than editing the request', () => {
    const result = runScript(ENFORCE_ENV, {
      modelResponse: CLEAN_RESPONSE,
      files: [SOURCE_FILE],
      reviews: [STALE_REQUEST],
    });

    expect(reviewPost(result).event).toBe('COMMENT');
    const edits = result.calls.filter(
      (call) => call.method === 'PUT' && call.url.endsWith('/reviews/41'),
    );
    expect(edits).toHaveLength(0);
  });

  it('dismisses the older request, not the new one, when it asks for changes again', () => {
    const result = runScript(ENFORCE_ENV, {
      modelResponse: BLOCKING_RESPONSE,
      files: [SOURCE_FILE],
      reviews: [STALE_REQUEST],
    });

    expect(reviewPost(result).event).toBe('REQUEST_CHANGES');
    expect(dismissals(result)).toHaveLength(1);
    expect(dismissals(result)[0].url).toContain('/reviews/41/dismissals');
    expect(result.status).toBe(1);
  });

  it('dismisses nothing when there is no earlier request', () => {
    const result = runScript(ENFORCE_ENV, {
      modelResponse: CLEAN_RESPONSE,
      files: [SOURCE_FILE],
    });

    expect(dismissals(result)).toHaveLength(0);
  });

  it('clears a stale request in comment-only mode too, so a rollback leaves nothing behind', () => {
    const result = runScript(BASE_ENV, {
      modelResponse: CLEAN_RESPONSE,
      files: [SOURCE_FILE],
      reviews: [STALE_REQUEST],
    });

    expect(dismissals(result)).toHaveLength(1);
  });

  it('dismisses the request when the review fails closed', () => {
    const result = runScript(ENFORCE_ENV, {
      modelResponse: 'not json at all',
      reviews: [STALE_REQUEST],
    });

    expect(reviewPost(result).body).toContain('fail-closed');
    expect(dismissals(result)).toHaveLength(1);
    expect(result.status).toBe(1);
  });

  it('does not let a failed dismissal change the outcome', () => {
    // The new verdict is already posted and the check is the gate. A
    // dismissal the token is not allowed to make is logged, not fatal.
    const result = runScript(ENFORCE_ENV, {
      modelResponse: CLEAN_RESPONSE,
      files: [SOURCE_FILE],
      reviews: [STALE_REQUEST],
      dismissStatus: 403,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('Could not dismiss review 41');
  });
});

describe('the script logs one stats line for calibration', () => {
  function statsLines(result: RunResult): unknown[] {
    return result.stdout
      .split('\n')
      .filter((line) => line.startsWith('QA_STATS '))
      .map((line) => JSON.parse(line.slice('QA_STATS '.length)) as unknown);
  }

  it('reports the counts, the token use and the commit of a completed review', () => {
    const result = runScript(BASE_ENV);

    const lines = statsLines(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      v: 2,
      pr: 7,
      sha: 'abc123',
      mode: 'comment-only',
      outcome: 'pass',
      files: 2,
      backendFiles: 1,
      frontendFiles: 0,
      omittedFiles: 0,
      shortenedPatches: 0,
      reported: 2,
      kept: { blocker: 0, major: 1, minor: 0, nit: 0 },
      tokens: { prompt: 1200, completion: 900, reasoning: 700 },
    });
  });

  it('reports a failed review, with the tokens it still cost', () => {
    const result = runScript(BASE_ENV, { modelResponse: 'not json at all' });

    const lines = statsLines(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      outcome: 'fail-closed',
      reported: null,
      kept: null,
      tokens: { prompt: 1200, completion: 900, reasoning: 700 },
    });
  });

  it('never puts a finding message in the stats line', () => {
    const result = runScript(BASE_ENV);

    const line = result.stdout.split('\n').find((l) => l.startsWith('QA_STATS ')) ?? '';
    expect(line).not.toContain('dropped without being used');
  });
});

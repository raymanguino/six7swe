import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Exercises the script end to end with the network stubbed.
 *
 * The script is the seam between the pure decision logic and the two side
 * effects, so the things worth proving are the ones a unit test of the
 * domain cannot: that it posts exactly one review, that the exit code
 * follows the gate outcome, and that a missing variable fails fast
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

  if (target.includes('/files')) {
    return new Response(JSON.stringify([
      {
        filename: 'backend/src/index.ts',
        status: 'modified',
        additions: 2,
        deletions: 1,
        patch: '@@ -1,2 +1,2 @@\\n ctx\\n-old\\n+new',
      },
      {
        filename: 'pnpm-lock.yaml',
        status: 'modified',
        additions: 9,
        deletions: 3,
        patch: 'lockfile noise',
      },
    ]), { status: 200 });
  }

  if (target.includes('/reviews') && method === 'GET') {
    return new Response('[]', { status: 200 });
  }

  if (target.includes('/reviews')) {
    return new Response(JSON.stringify({ id: 1 }), { status: 200 });
  }

  if (target.includes('minimax')) {
    return new Response(JSON.stringify({
      choices: [{ message: { content: globalThis.__MODEL_RESPONSE__ } }],
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

function runScript(env: Record<string, string>, modelResponse: string = MODEL_RESPONSE): RunResult {
  const stubFile = path.join(__dirname, '__stub.cjs');

  try {
    fs.writeFileSync(
      stubFile,
      `${STUB}\nglobalThis.__MODEL_RESPONSE__ = ${JSON.stringify(modelResponse)};\n` +
        `require(${JSON.stringify(SCRIPT)});\n`,
    );

    let stdout = '';
    let stderr = '';
    let status = 0;

    try {
      stdout = execFileSync(process.execPath, ['--import', 'tsx', stubFile], {
        encoding: 'utf-8',
        env: childEnv(env),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      status = failure.status ?? 1;
      stdout = failure.stdout ?? '';
      stderr = failure.stderr ?? '';
    }

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

    const post = result.calls.find(
      (call) => call.method === 'POST' && call.url.includes('/reviews'),
    );
    const body = JSON.parse(post?.body ?? '{}');

    expect(body.commit_id).toBe('abc123');
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

  it('posts a fail-closed review when the review cannot be completed', () => {
    // A model response that is not valid JSON is a broken review, not a
    // defect in the pull request. The outcome has to be reported as an
    // error, and the check has to go red.
    const result = runScript(BASE_ENV, 'not json at all');

    expect(result.status).not.toBe(0);

    const post = result.calls.find(
      (call) => call.method === 'POST' && call.url.includes('/reviews'),
    );
    const body = JSON.parse(post?.body ?? '{}');

    expect(body.body).toContain('fail-closed');
    expect(body.body).toContain('not a finding about this pull request');
  });

  it('still posts exactly one review when the review fails', () => {
    const result = runScript(BASE_ENV, 'not json at all');

    const posts = result.calls.filter(
      (call) => call.method === 'POST' && call.url.includes('/reviews'),
    );

    expect(posts).toHaveLength(1);
  });
});

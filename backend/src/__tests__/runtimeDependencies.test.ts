import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The backend compiles to CommonJS, so every external module is loaded with
 * `require()`. Some production dependencies (puppeteer 25+) are ESM only.
 * Node loads those through `require(esm)`, which is on by default from 22.12.
 * On anything older the backend crashes on startup with ERR_REQUIRE_ESM, and
 * that only shows on the deploy target, so CI never sees it.
 *
 * Two checks keep that from regressing:
 * 1. The Node floor in the root `engines.node` stays at 22.12 or above. The
 *    deploy builder installs Node from that field.
 * 2. Every external module the source imports loads via `require()`. This
 *    still catches ESM packages that `require(esm)` cannot load, such as ones
 *    that use top-level await (ERR_REQUIRE_ASYNC_MODULE).
 */
const REQUIRE_ESM_MIN_NODE: readonly [number, number] = [22, 12];

describe('runtime dependencies', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const srcRoot = path.join(backendRoot, 'src');
  const repoRoot = path.resolve(backendRoot, '..');

  const collectSourceFiles = (dir: string): string[] => {
    const found: string[] = [];
    for (const entry of readdirSync(dir)) {
      if (entry === '__tests__') continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        found.push(...collectSourceFiles(full));
      } else if (full.endsWith('.ts')) {
        found.push(full);
      }
    }
    return found;
  };

  const externalSpecifiers = (): string[] => {
    const specs = new Set<string>();
    const patterns = [
      /^\s*import\s+(?!type\b)[^'"]*?from\s+['"]([^'"]+)['"]/gm, // import x from 'y'
      /^\s*import\s+['"]([^'"]+)['"]/gm, // side-effect import 'y'
      /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, // require('y')
      /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, // dynamic import('y')
    ];

    for (const file of collectSourceFiles(srcRoot)) {
      const source = readFileSync(file, 'utf8');
      for (const pattern of patterns) {
        for (const match of source.matchAll(pattern)) {
          const spec = match[1];
          if (!spec) continue;
          if (spec.startsWith('.')) continue; // relative
          if (spec.startsWith('node:')) continue; // builtin
          specs.add(spec);
        }
      }
    }
    return [...specs].sort();
  };

  interface ProbeResult {
    stdout: string;
    stderr: string;
    failed: boolean;
  }

  const probe = (specs: string[]): ProbeResult => {
    const script = `
      for (const name of ${JSON.stringify(specs)}) {
        try {
          require(name);
        } catch (error) {
          const code = error && error.code ? error.code : 'UNKNOWN';
          console.error('FAILED:' + name + ':' + code + ':' + (error && error.message));
          process.exit(1);
        }
      }
      console.log('ALL_LOADED');
    `;

    try {
      const stdout = execFileSync(
        process.execPath,
        ['-e', script],
        { cwd: backendRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return { stdout, stderr: '', failed: false };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string };
      return {
        stdout: failure.stdout ?? '',
        stderr: failure.stderr ?? '',
        failed: true,
      };
    }
  };

  const nodeFloor = (): [number, number] => {
    const manifest: unknown = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
    const range =
      typeof manifest === 'object' &&
      manifest !== null &&
      'engines' in manifest &&
      typeof manifest.engines === 'object' &&
      manifest.engines !== null &&
      'node' in manifest.engines &&
      typeof manifest.engines.node === 'string'
        ? manifest.engines.node
        : '';
    const match = /^>=\s*(\d+)(?:\.(\d+))?/.exec(range.trim());
    if (!match) {
      throw new Error(`Root package.json engines.node must start with ">=", got "${range}"`);
    }
    return [Number(match[1]), Number(match[2] ?? 0)];
  };

  it('declares a Node floor that supports require(esm)', () => {
    const [major, minor] = nodeFloor();
    const [needMajor, needMinor] = REQUIRE_ESM_MIN_NODE;
    const supported = major > needMajor || (major === needMajor && minor >= needMinor);

    if (!supported) {
      throw new Error(
        `The root engines.node floor is ${major}.${minor}, but the backend needs ` +
          `${needMajor}.${needMinor}+.\n` +
          'Below that, require() of an ESM-only dependency (puppeteer) crashes the deployed\n' +
          'backend with ERR_REQUIRE_ESM while CI stays green.'
      );
    }
  });

  it('imports external modules that are loadable via require()', () => {
    const specs = externalSpecifiers();
    expect(specs.length).toBeGreaterThan(0);

    const result = probe(specs);

    if (result.failed) {
      throw new Error(
        'A production dependency cannot be loaded via require().\n' +
          'That crashes the deployed backend on startup while CI stays green.\n' +
          'Pin the offending package to a loadable release with a pnpm override in\n' +
          'pnpm-workspace.yaml.\n\n' +
          `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`
      );
    }

    expect(result.stdout).toContain('ALL_LOADED');
  });
});

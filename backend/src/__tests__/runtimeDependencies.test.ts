import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The backend compiles to CommonJS. `require()` of an ESM-only package throws
 * ERR_REQUIRE_ESM on Node < 22.12, which has no `require(esm)` support.
 * That only fails on the deploy target, so CI never sees it.
 *
 * The check below loads every external module the source imports with
 * `require(esm)` disabled, which reproduces the Node 18 behaviour exactly.
 */
describe('runtime dependencies', () => {
  const backendRoot = path.resolve(__dirname, '..', '..');
  const srcRoot = path.join(backendRoot, 'src');

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
        ['--no-experimental-require-module', '-e', script],
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

  it('imports external modules that are loadable via require()', () => {
    const specs = externalSpecifiers();
    expect(specs.length).toBeGreaterThan(0);

    const result = probe(specs);

    if (result.failed) {
      throw new Error(
        'A production dependency cannot be loaded via require() on Node < 22.12.\n' +
          'That crashes the deployed backend with ERR_REQUIRE_ESM while CI stays green.\n' +
          'Pin the offending package to a CommonJS release with a pnpm override in\n' +
          'pnpm-workspace.yaml, or raise the Node requirement in package.json.\n\n' +
          `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`
      );
    }

    expect(result.stdout).toContain('ALL_LOADED');
  });
});

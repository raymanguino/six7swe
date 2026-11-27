import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import path from 'node:path';
import ts from 'typescript';

/**
 * The API never launches Chrome: refreshes run on the scraper worker. This
 * walks the modules `src/index.ts` loads at runtime, as `tsc` emits them with
 * the backend's compiler options (type-only imports are erased), and checks
 * that none reaches puppeteer or the scraper. The worker is walked too, so the
 * check cannot pass by missing the imports altogether.
 */

const backendRoot = path.resolve(__dirname, '..', '..');
const srcRoot = path.join(backendRoot, 'src');

const compilerOptions = ((): ts.CompilerOptions => {
  const configPath = path.join(backendRoot, 'tsconfig.json');
  const { config } = ts.readConfigFile(configPath, (file) => readFileSync(file, 'utf8'));
  return ts.parseJsonConfigFileContent(config, ts.sys, backendRoot).options;
})();

const dependencies = new Set(
  Object.keys(
    (
      JSON.parse(readFileSync(path.join(backendRoot, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>;
      }
    ).dependencies ?? {},
  ),
);

/** `@scope/name/sub` -> `@scope/name`; `name/sub` -> `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : (parts[0] ?? specifier);
}

/** The specifiers a module `require`s once compiled. */
function runtimeRequires(file: string): string[] {
  const { outputText } = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions,
    fileName: file,
  });
  return [...outputText.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].flatMap((match) =>
    match[1] ? [match[1]] : [],
  );
}

function resolveRelative(from: string, specifier: string): string {
  const base = path.resolve(path.dirname(from), specifier);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(`Cannot resolve ${specifier} from ${from}`);
}

/**
 * Every source module and external package `entry` loads, transitively. A
 * specifier that is neither relative, a Node builtin nor a dependency (a path
 * alias, say) fails the walk, so it cannot hide an import.
 */
function importGraph(entry: string): { modules: Set<string>; packages: Set<string> } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (modules.has(file)) continue;
    modules.add(file);
    for (const specifier of runtimeRequires(file)) {
      if (specifier.startsWith('.')) {
        pending.push(resolveRelative(file, specifier));
      } else if (specifier.startsWith('node:') || builtinModules.includes(specifier)) {
        continue;
      } else if (dependencies.has(packageName(specifier))) {
        packages.add(specifier);
      } else {
        throw new Error(`${file} requires "${specifier}", which is not a backend dependency`);
      }
    }
  }
  return { modules, packages };
}

const scraperDir = path.join(srcRoot, 'services', 'jobFetchers') + path.sep;
const reachesScraper = (graph: ReturnType<typeof importGraph>): boolean =>
  [...graph.packages].some((pkg) => pkg.startsWith('puppeteer')) ||
  [...graph.modules].some((file) => file.startsWith(scraperDir));

describe('the API import graph', () => {
  it('never loads puppeteer or the scraper', () => {
    const graph = importGraph(path.join(srcRoot, 'index.ts'));
    // Sanity: the walk followed the API's plugins and routes.
    expect(graph.modules).toContain(path.join(srcRoot, 'plugins', 'jobRefreshService.ts'));
    expect(reachesScraper(graph)).toBe(false);
  });

  it('is checked by a walk that does find puppeteer from the worker', () => {
    expect(reachesScraper(importGraph(path.join(srcRoot, 'worker.ts')))).toBe(true);
  });
});

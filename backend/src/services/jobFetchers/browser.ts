import puppeteer, { Browser } from 'puppeteer';

/**
 * The only variables Chrome inherits. It runs with `--no-sandbox`, so a renderer exploit could
 * read its environment: the backend's secrets (DATABASE_URL, KNOWLEDGE_*, RESEND_*, MINIMAX_*,
 * SUPABASE_*) stay out. Paths, locale, temp and fonts on Linux; the Windows names for local runs.
 */
const CHROME_ENV_KEYS = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'TZ',
  'TMPDIR',
  'FONTCONFIG_PATH',
  'FONTCONFIG_FILE',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'DISPLAY',
  'TEMP',
  'TMP',
  'SystemRoot',
  'windir',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'ProgramData',
] as const;

/** Chrome's environment: the allowlisted variables that are set, nothing else. */
export function chromeEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of CHROME_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) result[key] = value;
  }
  return result;
}

export async function newBrowser(): Promise<Browser> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--incognito', '--no-sandbox', '--disable-setuid-sandbox'],
    env: chromeEnv(),
  });
  if (!browser) {
    throw new Error('Failed to launch browser');
  }
  return browser;
}

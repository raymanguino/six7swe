/**
 * Limits of the public MCP endpoint (`POST /mcp/public`, #205).
 *
 * - `PUBLIC_MCP_RATE_LIMIT_MAX` requests per client per
 *   `PUBLIC_MCP_RATE_LIMIT_WINDOW_MS`, counted per HTTP request (an MCP
 *   handshake is two or three of them). Tighter than `/chat`'s 10 a minute.
 * - `PUBLIC_MCP_DAILY_SEARCH_CAP` `search_background` calls a UTC day across
 *   all clients, since each one costs an embedding, and
 *   `PUBLIC_MCP_CLIENT_DAILY_SEARCH_CAP` per client, so one client cannot
 *   spend everyone's day. A search whose retrieval fails is given back.
 * - Of those, `PUBLIC_MCP_DAILY_RECORD_CAP` a day across all clients, and the
 *   first `PUBLIC_MCP_CLIENT_DAILY_RECORD_CAP` per client, are recorded in
 *   the eval set; the rest are answered but not recorded, so public searches
 *   cannot flood the owner's candidate pool.
 *
 * Daily budgets are counted in this process's memory: the backend runs one
 * replica, so they are global; with more replicas they would apply per
 * replica, and a restart resets them.
 *
 * A missing or malformed value falls back to its default.
 */
export interface PublicMcpConfig {
  rateLimitMax: number;
  rateLimitWindowMs: number;
  dailySearchCap: number;
  clientDailySearchCap: number;
  dailyRecordCap: number;
  clientDailyRecordCap: number;
}

export const DEFAULT_PUBLIC_MCP_CONFIG: PublicMcpConfig = {
  rateLimitMax: 20,
  rateLimitWindowMs: 10 * 60_000,
  dailySearchCap: 500,
  clientDailySearchCap: 50,
  dailyRecordCap: 100,
  clientDailyRecordCap: 5,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

const ENV_NAMES: Record<keyof PublicMcpConfig, string> = {
  rateLimitMax: 'PUBLIC_MCP_RATE_LIMIT_MAX',
  rateLimitWindowMs: 'PUBLIC_MCP_RATE_LIMIT_WINDOW_MS',
  dailySearchCap: 'PUBLIC_MCP_DAILY_SEARCH_CAP',
  clientDailySearchCap: 'PUBLIC_MCP_CLIENT_DAILY_SEARCH_CAP',
  dailyRecordCap: 'PUBLIC_MCP_DAILY_RECORD_CAP',
  clientDailyRecordCap: 'PUBLIC_MCP_CLIENT_DAILY_RECORD_CAP',
};

export function getPublicMcpConfig(
  env: Record<string, string | undefined> = process.env,
): PublicMcpConfig {
  const config = { ...DEFAULT_PUBLIC_MCP_CONFIG };
  for (const key of Object.keys(ENV_NAMES) as (keyof PublicMcpConfig)[]) {
    config[key] = positiveInt(env[ENV_NAMES[key]], DEFAULT_PUBLIC_MCP_CONFIG[key]);
  }
  return config;
}

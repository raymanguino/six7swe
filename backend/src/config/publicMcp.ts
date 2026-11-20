/**
 * Limits of the public MCP endpoint (`POST /mcp/public`, #205).
 *
 * - `PUBLIC_MCP_RATE_LIMIT_MAX` requests per client per
 *   `PUBLIC_MCP_RATE_LIMIT_WINDOW_MS`, counted per HTTP request (an MCP
 *   handshake is two or three of them). Tighter than `/chat`'s 10 a minute.
 * - `PUBLIC_MCP_DAILY_SEARCH_CAP` `search_background` calls a UTC day across
 *   all clients, since each one costs an embedding. It is counted in this
 *   process's memory: the backend runs one replica, so it is the global cap;
 *   with more replicas it would apply per replica, and a restart resets it.
 *
 * A missing or malformed value falls back to its default.
 */
export interface PublicMcpConfig {
  rateLimitMax: number;
  rateLimitWindowMs: number;
  dailySearchCap: number;
}

export const DEFAULT_PUBLIC_MCP_CONFIG: PublicMcpConfig = {
  rateLimitMax: 20,
  rateLimitWindowMs: 10 * 60_000,
  dailySearchCap: 500,
};

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  if (!raw || !Number.isInteger(n) || n < 1) return fallback;
  return n;
}

export function getPublicMcpConfig(
  env: Record<string, string | undefined> = process.env,
): PublicMcpConfig {
  return {
    rateLimitMax: positiveInt(
      env.PUBLIC_MCP_RATE_LIMIT_MAX,
      DEFAULT_PUBLIC_MCP_CONFIG.rateLimitMax,
    ),
    rateLimitWindowMs: positiveInt(
      env.PUBLIC_MCP_RATE_LIMIT_WINDOW_MS,
      DEFAULT_PUBLIC_MCP_CONFIG.rateLimitWindowMs,
    ),
    dailySearchCap: positiveInt(
      env.PUBLIC_MCP_DAILY_SEARCH_CAP,
      DEFAULT_PUBLIC_MCP_CONFIG.dailySearchCap,
    ),
  };
}

/**
 * Redis-backed cache for search results, with a deliberate fail-open design:
 * if REDIS_URL isn't set, or Redis is unreachable, every method becomes a
 * silent no-op instead of throwing — the server keeps working without a
 * cache, it's just slower. This is the same "decide fail-open vs fail-closed"
 * tradeoff from the Redis/rate-limiting guide, applied for real here: for a
 * cache (not a security control), fail-open is clearly the right call.
 */
import { createClient } from "redis";
import crypto from "node:crypto";

const DEFAULT_TTL_SECONDS = 300; // 5 minutes: search results go stale as notes are added

export class SearchCache {
  constructor(url = process.env.REDIS_URL) {
    this.enabled = Boolean(url);
    this.client = null;
    this.connecting = null;
    this.url = url;
  }

  async _getClient() {
    if (!this.enabled) return null;
    if (this.client) return this.client;
    if (!this.connecting) {
      this.connecting = (async () => {
        const client = createClient({
          url: this.url,
          socket: {
            // Fail fast instead of hanging: a search should never block on a
            // slow/unreachable cache. Also don't auto-reconnect forever —
            // one bad attempt is enough to fall back to "no cache" for this run.
            connectTimeout: 1500,
            reconnectStrategy: false,
          },
        });
        client.on("error", (err) => {
          // Never let a Redis connection error crash the MCP server.
          console.error("[cache] Redis error, disabling cache for this session:", err.message);
          this.enabled = false;
        });
        try {
          await client.connect();
          this.client = client;
        } catch (err) {
          console.error("[cache] Could not connect to Redis, continuing without cache:", err.message);
          this.enabled = false;
          return null;
        }
        return client;
      })();
    }
    return this.connecting;
  }

  /** Deterministic cache key: normalize the query so wording variants collide sensibly. */
  static keyFor(query, topK) {
    const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
    const hash = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    return `mcp-kb:search:${topK}:${hash}`;
  }

  async get(query, topK) {
    if (!this.enabled) return null;
    try {
      const client = await this._getClient();
      if (!client) return null;
      const raw = await client.get(SearchCache.keyFor(query, topK));
      return raw ? JSON.parse(raw) : null;
    } catch (err) {
      console.error("[cache] get() failed, treating as a miss:", err.message);
      return null;
    }
  }

  async set(query, topK, results, ttlSeconds = DEFAULT_TTL_SECONDS) {
    if (!this.enabled) return;
    try {
      const client = await this._getClient();
      if (!client) return;
      // Small random jitter on the TTL avoids many keys expiring in the same instant.
      const jitter = Math.floor(Math.random() * 20);
      await client.set(SearchCache.keyFor(query, topK), JSON.stringify(results), {
        EX: ttlSeconds + jitter,
      });
    } catch (err) {
      console.error("[cache] set() failed, continuing without caching this result:", err.message);
    }
  }

  /** Called after any write (add/delete) so stale search results aren't served. */
  async invalidateAll() {
    if (!this.enabled) return;
    try {
      const client = await this._getClient();
      if (!client) return;
      let cursor = "0";
      do {
        const reply = await client.scan(cursor, { MATCH: "mcp-kb:search:*", COUNT: 100 });
        cursor = reply.cursor;
        if (reply.keys.length > 0) await client.del(reply.keys);
      } while (cursor !== "0");
    } catch (err) {
      console.error("[cache] invalidateAll() failed:", err.message);
    }
  }

  async close() {
    if (this.client) await this.client.quit().catch(() => {});
  }
}

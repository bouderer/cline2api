/**
 * Model catalog.
 *
 * Two public upstream endpoints feed the advertised list, because neither is
 * sufficient on its own:
 *
 *   GET /api/v1/models                       — the big provider catalog
 *                                              (verified live: 444 entries).
 *   GET /api/v1/ai/cline/recommended-models  — the same list Cline's own UI
 *                                              shows, split into the
 *                                              `free` / `clinePass` buckets.
 *
 * Which bucket an id belongs to decides who pays for it, and only the second
 * endpoint knows: a Cline Pass covers `clinePass/*`, the free bucket costs
 * nothing, and everything else bills against Cline Credits. So the bucket is
 * carried from the source that declared it rather than inferred from the id —
 * `stealth/union-alpha` and `z-ai/glm-5.3-flash` sit in the provider catalog
 * *and* in the free bucket, and guessing from the name would bill them wrong.
 * Ids are forwarded upstream verbatim in both directions.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import {
  CLINE_MODELS_PATH,
  CLINE_RECOMMENDED_MODELS_PATH,
  FALLBACK_FREE_MODEL_IDS,
  FALLBACK_MODEL_IDS,
  FALLBACK_PASS_MODEL_IDS,
} from "./constants.js";

/** Who pays for a model: the subscription, nothing, or Cline Credits. */
export type ModelBucket = "pass" | "free" | "credits";

export interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
  /** Billing bucket, as declared by the catalog that listed the id. */
  bucket: ModelBucket;
}

/** `owned_by` we give to entries only the recommended-models catalog knows. */
const PASS_OWNER = "cline-pass";
const FREE_OWNER = "cline-free";

function toEntry(id: string, ownedBy: string, created: number, bucket: ModelBucket): ModelEntry {
  return { id, object: "model" as const, created, owned_by: ownedBy, bucket };
}

/** Read one `{id}` array out of the recommended-models payload. */
function readBucket(raw: unknown, owner: string, bucket: ModelBucket): ModelEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter(
      (item): item is { id: string } =>
        typeof item === "object" && item !== null && typeof (item as { id?: unknown }).id === "string",
    )
    .map((item) => toEntry(item.id, owner, 0, bucket));
}

/**
 * Ids known to be free even though upstream's recommended-models list omits
 * them.
 *
 * `cline-free/kimi-k3` is the case that motivated this: the free catalog does
 * not advertise it, but the usage ledger bills it under `aiModelTypeName:
 * "cline-free"` with `creditsUsed: 0`, so it is a free model in practice and
 * callers need to see it in the free bucket rather than have it silently fall
 * into "credits".
 */
const KNOWN_FREE_MODEL_IDS: readonly string[] = ["cline-free/kimi-k3"];

/**
 * Provider catalog first (insertion order is what clients see), then the
 * subscription and free buckets. A duplicate id keeps its provider metadata
 * but takes the bucket from the catalog that positioned it — the free bucket
 * wins over the subscription bucket, and both win over "credits".
 */
function merge(primary: ModelEntry[], pass: ModelEntry[], free: ModelEntry[]): ModelEntry[] {
  const byId = new Map<string, ModelEntry>();
  for (const entry of primary) byId.set(entry.id, entry);
  for (const entry of [pass, free]) {
    for (const candidate of entry) {
      const existing = byId.get(candidate.id);
      byId.set(candidate.id, existing ? { ...existing, bucket: candidate.bucket } : candidate);
    }
  }
  // Applied last so the free bucket wins, which is the same precedence the
  // merge above uses for a catalog that does declare these ids.
  for (const id of KNOWN_FREE_MODEL_IDS) {
    const existing = byId.get(id);
    byId.set(id, existing
      ? { ...existing, bucket: "free" }
      : toEntry(id, FREE_OWNER, 0, "free"));
  }
  return [...byId.values()];
}

export class ModelCatalog {
  private cache: { at: number; entries: ModelEntry[] } | null = null;
  private inflight: Promise<ModelEntry[]> | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {}

  async list(): Promise<ModelEntry[]> {
    const cached = this.cache;
    if (cached && Date.now() - cached.at < this.config.modelCacheTtlMs) {
      return cached.entries;
    }
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchCatalog().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async fetchCatalog(): Promise<ModelEntry[]> {
    const [primary, buckets] = await Promise.all([
      this.fetchPrimaryCatalog(),
      this.fetchRecommendedCatalog(),
    ]);
    const entries = merge(primary ?? [], buckets.pass, buckets.free);

    if (entries.length === 0) {
      if (this.cache) return this.cache.entries;
      this.logger.warn("both model catalogs unavailable, serving the fallback list");
      return [
        ...FALLBACK_MODEL_IDS.map((id) =>
          toEntry(id, id.split("/")[0] ?? "cline", 0, "credits"),
        ),
        ...FALLBACK_PASS_MODEL_IDS.map((id) => toEntry(id, PASS_OWNER, 0, "pass")),
        ...FALLBACK_FREE_MODEL_IDS.map((id) => toEntry(id, FREE_OWNER, 0, "free")),
        ...KNOWN_FREE_MODEL_IDS.map((id) => toEntry(id, FREE_OWNER, 0, "free")),
      ];
    }

    // Only cache a complete catalog; a partial one (provider list unavailable)
    // is retried on the next call instead of being pinned for the whole TTL.
    if (primary !== null) this.cache = { at: Date.now(), entries };
    this.logger.info(`model catalog refreshed (${entries.length} models)`);
    return entries;
  }

  /** The provider catalog. Returns null when the call fails. */
  private async fetchPrimaryCatalog(): Promise<ModelEntry[] | null> {
    const url = `${this.config.clineApiBaseUrl}${CLINE_MODELS_PATH}`;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { data?: unknown };
      const raw = Array.isArray(payload.data) ? payload.data : [];
      const entries: ModelEntry[] = raw
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .filter((item) => typeof item.id === "string")
        .map((item) =>
          toEntry(
            item.id as string,
            typeof item.owned_by === "string" ? item.owned_by : "cline",
            typeof item.created === "number" ? item.created : 0,
            "credits",
          ),
        );
      if (entries.length === 0) throw new Error("empty catalog");
      return entries;
    } catch (error) {
      this.logger.warn(`model catalog fetch failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Free + subscription buckets. Never throws; returns empty lists on failure. */
  private async fetchRecommendedCatalog(): Promise<{ pass: ModelEntry[]; free: ModelEntry[] }> {
    const url = `${this.config.clineApiBaseUrl}${CLINE_RECOMMENDED_MODELS_PATH}`;
    try {
      const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = (await response.json()) as { free?: unknown; clinePass?: unknown };
      return {
        pass: readBucket(payload.clinePass, PASS_OWNER, "pass"),
        free: readBucket(payload.free, FREE_OWNER, "free"),
      };
    } catch (error) {
      this.logger.warn(`recommended model catalog fetch failed: ${(error as Error).message}`);
      return { pass: [], free: [] };
    }
  }

  /** `/v1/models` entries. The bucket stays internal: it is not OpenAI shape. */
  static toOpenAIModels(entries: ModelEntry[]): Array<Omit<ModelEntry, "bucket">> {
    return entries.map(({ id, object, created, owned_by }) => ({ id, object, created, owned_by }));
  }
}

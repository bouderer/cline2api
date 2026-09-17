/**
 * Model catalog.
 *
 * `GET {clineApiBaseUrl}/api/v1/models` is public (verified live: 444 entries,
 * no auth required), so the gateway always advertises the real, current
 * catalog instead of a hardcoded list that silently rots. Model ids are used
 * verbatim upstream — the `cline-pass/` prefix seen in older write-ups is not
 * part of the current API.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { CLINE_MODELS_PATH, FALLBACK_MODEL_IDS } from "./constants.js";

export interface ModelEntry {
  id: string;
  object: "model";
  created: number;
  owned_by: string;
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
        .map((item) => ({
          id: item.id as string,
          object: "model" as const,
          created: typeof item.created === "number" ? item.created : 0,
          owned_by: typeof item.owned_by === "string" ? item.owned_by : "cline",
        }));
      if (entries.length === 0) throw new Error("empty catalog");
      this.cache = { at: Date.now(), entries };
      this.logger.info(`model catalog refreshed (${entries.length} models)`);
      return entries;
    } catch (error) {
      this.logger.warn(`model catalog fetch failed, using fallback: ${(error as Error).message}`);
      const fallback: ModelEntry[] = FALLBACK_MODEL_IDS.map((id) => ({
        id,
        object: "model" as const,
        created: 0,
        owned_by: id.split("/")[0] ?? "cline",
      }));
      if (this.cache) return this.cache.entries;
      return fallback;
    }
  }
}

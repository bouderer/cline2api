/**
 * Exit-IP probe for a configured proxy.
 *
 * The pool's whole point is that different accounts leave through different
 * addresses, and the only number that matters for a rate limit is the address
 * upstream actually sees — which is not always the proxy's hostname. Rotating
 * pools hand out one of many backends behind a single host, and a pool whose
 * credentials have expired resolves just fine but carries no traffic.
 *
 * So the exit address is *measured*, by asking an IP echo service over the
 * proxy itself, rather than inferred from the URL. The caller stores the result
 * on the proxy record so the list view can show it without probing on every
 * page load.
 *
 * `ipify` is the primary because it answers with a bare address and no JSON
 * envelope to parse; `ifconfig.me` is the fallback for when a proxy's egress
 * filter blocks the first one. Two hosts rather than one because a single
 * reachability failure would otherwise read as "this proxy is broken" when the
 * proxy is fine and only the echo service is unreachable from that network.
 */
import { ProxyAgent } from "undici";
import type { Logger } from "../logger.js";
import type { AppConfig } from "../config.js";
import { postChatCompletions } from "../cline/upstream.js";

/** Echo services that answer with a bare IP address, tried in order. */
const ECHO_HOSTS = ["https://api.ipify.org", "https://ifconfig.me/ip"] as const;

/** Upstream's "the model produced no content" error, which still proves the request reached inference. */
const EMPTY_CONTENT = /empty response content/i;

/** One address, and nothing else, so a portal page cannot masquerade as one. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

export interface ProxyExitOk {
  ok: true;
  exitIp: string;
  latencyMs: number;
}

export interface ProxyExitError {
  ok: false;
  error: string;
}

export type ProxyExitResult = ProxyExitOk | ProxyExitError;

/**
 * Report the IP a proxy egresses from.
 *
 * A fresh agent is built per probe and closed afterwards: probing happens on
 * demand from the admin UI, so there is no request stream to share a pool with,
 * and reusing the request path's cached agent would mean a probe failure could
 * leave its error state on a live proxy.
 */
export async function probeProxyExit(
  url: string,
  logger: Logger,
  timeoutMs = 12_000,
): Promise<ProxyExitResult> {
  let agent: ProxyAgent;
  try {
    agent = new ProxyAgent({ uri: url, connectTimeout: timeoutMs });
  } catch (error) {
    return { ok: false, error: `cannot build proxy agent: ${(error as Error).message}` };
  }

  const started = Date.now();
  try {
    const failures: string[] = [];
    for (const host of ECHO_HOSTS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(host, {
          signal: controller.signal,
          dispatcher: agent,
        } as RequestInit & { dispatcher: ProxyAgent });
        if (!response.ok) {
          failures.push(`${host}: HTTP ${response.status}`);
          continue;
        }
        const text = (await response.text()).trim();
        if (!IPV4.test(text)) {
          failures.push(`${host}: not an IP (${text.slice(0, 40)})`);
          continue;
        }
        return { ok: true, exitIp: text, latencyMs: Date.now() - started };
      } catch (error) {
        const cause = (error as { cause?: { message?: string } }).cause;
        failures.push(`${host}: ${cause?.message ?? (error as Error).message}`);
      } finally {
        clearTimeout(timer);
      }
    }
    logger.warn("proxy exit probe failed", { failures });
    return { ok: false, error: failures.join("; ") };
  } finally {
    void agent.close().catch(() => undefined);
  }
}

/** What a Cline probe returns, beyond plain exit reachability. */
export interface ProxyClineProbe {
  ok: boolean;
  /** Upstream HTTP status when a response came back (200/401/403/429/...). */
  status?: number;
  latencyMs?: number;
  /** First ~200 chars of the upstream body, for diagnosing a refusal. */
  detail?: string;
  error?: string;
}

/**
 * Probe whether a proxy can actually serve a gated free model through Cline.
 *
 * `probeProxyExit` only proves the proxy reaches an IP-echo host; it says
 * nothing about the Cline product-surface gate (`X-CLIENT-TYPE: Cline` and
 * friends) that `cline-free/*` enforces. A proxy can answer ipify and still be
 * refused by Cline, so the only meaningful test is a real (tiny, free) chat
 * request through it.
 *
 * The caller supplies a live account's `authorization` — the probe borrows one
 * account's credential but routes it through the proxy under test. Cost is
 * nil: the model is in the free bucket and the body asks for a single token.
 */
export async function probeProxyCline(
  url: string,
  config: AppConfig,
  authorization: string,
  logger: Logger,
  timeoutMs = 20_000,
): Promise<ProxyClineProbe> {
  let agent: ProxyAgent;
  try {
    agent = new ProxyAgent({ uri: url, connectTimeout: timeoutMs });
  } catch (error) {
    return { ok: false, error: `cannot build proxy agent: ${(error as Error).message}` };
  }

  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await postChatCompletions(
      config,
      {
        model: "cline-free/deepseek-v4.1-flash",
        messages: [{ role: "user", content: "hi" }],
        // Enough budget that a reasoning model still emits content: a 1-token
        // ask gets spent entirely on reasoning and upstream answers
        // `empty response content`, which would read as a broken proxy.
        max_tokens: 512,
        stream: false,
      },
      {
        authorization,
        taskId: `proxy-probe-${Date.now()}`,
        signal: controller.signal,
        dispatcher: agent,
      },
    );
    const latencyMs = Date.now() - started;
    const body = await response.text().catch(() => "");
    if (response.ok) {
      return { ok: true, status: response.status, latencyMs };
    }
    // `empty response content` comes from the model, not the edge: the request
    // cleared the product-surface gate and reached inference, so the proxy is
    // usable. A reasoning model can still exhaust any budget on thinking, so
    // this cannot be treated as a proxy failure.
    if (EMPTY_CONTENT.test(body)) {
      return { ok: true, status: response.status, latencyMs, detail: "reached model (empty content)" };
    }
    logger.warn("proxy cline probe refused", { status: response.status, body: body.slice(0, 120) });
    return { ok: false, status: response.status, latencyMs, detail: body.slice(0, 200) };
  } catch (error) {
    const cause = (error as { cause?: { message?: string } }).cause;
    const message = cause?.message ?? (error as Error).message;
    logger.warn("proxy cline probe failed", { error: message });
    return { ok: false, error: message, latencyMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    void agent.close().catch(() => undefined);
  }
}

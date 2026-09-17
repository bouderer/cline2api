import assert from "node:assert/strict";
import test from "node:test";
import {
  ClineAuthError,
  formatAccessToken,
  parseAuthError,
  stripAccessToken,
  isCredentialExpiring,
  getValidClineCredentials,
} from "../src/cline/auth.js";
import type { ClineCredentials } from "../src/cline/types.js";

test("access token prefix round-trips", () => {
  assert.equal(formatAccessToken("abc"), "workos:abc");
  assert.equal(formatAccessToken("workos:abc"), "workos:abc");
  assert.equal(formatAccessToken("WORKOS:abc"), "WORKOS:abc");
  assert.equal(stripAccessToken("workos:abc"), "abc");
  assert.equal(stripAccessToken("abc"), "abc");
});

test("invalid_grant detection matches upstream heuristic", () => {
  assert.equal(new ClineAuthError("nope", { errorCode: "invalid_grant" }).isLikelyInvalidGrant(), true);
  assert.equal(new ClineAuthError("token invalid", { status: 401 }).isLikelyInvalidGrant(), true);
  assert.equal(new ClineAuthError("boom", { status: 500 }).isLikelyInvalidGrant(), false);
  assert.equal(new ClineAuthError("socket hang up").isLikelyInvalidGrant(), false);
  assert.equal(new ClineAuthError("revoked", { status: 400 }).isLikelyInvalidGrant(), true);
});

test("parseAuthError accepts both error shapes", () => {
  assert.deepEqual(parseAuthError('{"message":"bad","code":"invalid_grant"}'), {
    message: "bad",
    code: "invalid_grant",
  });
  assert.deepEqual(parseAuthError('{"error":"nope"}'), { message: "nope" });
  assert.deepEqual(parseAuthError("not json"), { message: "not json" });
});

test("credentials expiring within the buffer are refreshed", () => {
  const soon = Date.now() + 60_000;
  assert.equal(isCredentialExpiring({ access: "a", refresh: "r", expires: soon }, 5 * 60_000), true);
  assert.equal(isCredentialExpiring({ access: "a", refresh: "r", expires: soon }, 30_000), false);
});

const options = {
  clineApiBaseUrl: "https://api.cline.bot",
  workosApiBaseUrl: "https://api.workos.com",
  clientId: "client_test",
  requestTimeoutMs: 5_000,
};

const fresh: ClineCredentials = {
  access: "a",
  refresh: "r",
  expires: Date.now() + 3_600_000,
};

test("a still-valid credential is returned without touching the network", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("network must not be used");
  }) as typeof fetch;
  try {
    const resolved = await getValidClineCredentials(fresh, options);
    assert.equal(resolved, fresh);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("null credentials resolve to null (no account)", async () => {
  assert.equal(await getValidClineCredentials(null, options), null);
});

test("a rejected refresh token resolves to null, not a throw", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "invalid refresh", code: "invalid_grant" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    const expired: ClineCredentials = { access: "a", refresh: "dead", expires: Date.now() - 1000 };
    assert.equal(await getValidClineCredentials(expired, options, { forceRefresh: true }), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a transient refresh failure keeps a still-usable token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream exploded", { status: 503 })) as typeof fetch;
  try {
    const usable: ClineCredentials = { access: "a", refresh: "r", expires: Date.now() + 10 * 60_000 };
    const resolved = await getValidClineCredentials(usable, options, { forceRefresh: true });
    assert.equal(resolved, usable);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a transient refresh failure throws once the token is already dead", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("upstream exploded", { status: 503 })) as typeof fetch;
  try {
    const dead: ClineCredentials = { access: "a", refresh: "r", expires: Date.now() - 1000 };
    await assert.rejects(() => getValidClineCredentials(dead, options, { forceRefresh: true }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("refresh posts to /api/v1/auth/refresh with the official body shape", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody = "";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = String(init?.body ?? "");
    return new Response(
      JSON.stringify({
        success: true,
        data: {
          accessToken: "new-access",
          refreshToken: "new-refresh",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          userInfo: { email: "a@b.c", clineUserId: "cu_1" },
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const usable: ClineCredentials = { access: "a", refresh: "old", expires: Date.now() + 10 * 60_000 };
    const resolved = await getValidClineCredentials(usable, options, { forceRefresh: true });
    assert.equal(seenUrl, "https://api.cline.bot/api/v1/auth/refresh");
    assert.deepEqual(JSON.parse(seenBody), { refreshToken: "old", grantType: "refresh_token" });
    assert.equal(resolved?.access, "new-access");
    assert.equal(resolved?.refresh, "new-refresh");
    assert.equal(resolved?.accountId, "cu_1");
    assert.equal(resolved?.email, "a@b.c");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

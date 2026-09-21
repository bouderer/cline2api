import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClineAuthError,
  exchangeAuthorizationCode,
  formatAccessToken,
  parseAuthError,
  stripAccessToken,
  isCredentialExpiring,
  getValidClineCredentials,
  startCallbackAuth,
} from "../src/cline/auth.js";
import { startLocalCallbackServer } from "../src/cline/callbackServer.js";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";
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

test("callback auth follows the authorize redirect and selects MicrosoftOAuth", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenInit = init;
    return new Response(null, {
      status: 302,
      headers: {
        location:
          "https://api.workos.com/user_management/authorize?client_id=client_test&provider=authkit",
      },
    });
  }) as typeof fetch;
  try {
    const callbackUrl = "http://127.0.0.1:48801/auth";
    const result = await startCallbackAuth(options, callbackUrl);
    const requested = new URL(seenUrl);
    assert.equal(requested.pathname, "/api/v1/auth/authorize");
    assert.equal(requested.searchParams.get("client_type"), "extension");
    assert.equal(requested.searchParams.get("callback_url"), callbackUrl);
    assert.equal(requested.searchParams.get("redirect_uri"), callbackUrl);
    assert.equal(seenInit?.redirect, "manual");

    const redirected = new URL(result);
    assert.equal(redirected.searchParams.get("provider"), "MicrosoftOAuth");
    assert.equal(redirected.searchParams.get("client_id"), "client_test");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authorization code exchange posts the official body and parses tokens", async () => {
  const originalFetch = globalThis.fetch;
  let seenUrl = "";
  let seenBody: Record<string, unknown> = {};
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seenUrl = String(url);
    seenBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        access_token: "workos-access",
        refresh_token: "workos-refresh",
        token_type: "Bearer",
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const callbackUrl = "http://127.0.0.1:48801/auth";
    const result = await exchangeAuthorizationCode("auth-code", callbackUrl, options);
    assert.equal(seenUrl, "https://api.cline.bot/api/v1/auth/token");
    assert.deepEqual(seenBody, {
      grant_type: "authorization_code",
      code: "auth-code",
      client_type: "extension",
      redirect_uri: callbackUrl,
    });
    assert.equal(result.accessToken, "workos-access");
    assert.equal(result.refreshToken, "workos-refresh");
    assert.equal(result.tokenType, "Bearer");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("authorization code exchange classifies invalid_grant errors", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "authorization code expired", code: "invalid_grant" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    })) as typeof fetch;
  try {
    await assert.rejects(
      () => exchangeAuthorizationCode("expired", "http://127.0.0.1:48801/auth", options),
      (error: unknown) => {
        assert.ok(error instanceof ClineAuthError);
        assert.equal(error.status, 400);
        assert.equal(error.errorCode, "invalid_grant");
        assert.equal(error.isLikelyInvalidGrant(), true);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("localhost callback server resolves the code and releases its port", async () => {
  const server = await startLocalCallbackServer({ ports: [0], timeoutMs: 2_000 });
  try {
    const response = await fetch(`${server.callbackUrl}?code=callback-code`);
    assert.equal(response.status, 200);
    assert.equal(await server.code, "callback-code");
  } finally {
    await server.close();
  }
});
test("account import upserts, converts seconds, and skips invalid rows", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-import-"));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: "http://127.0.0.1:1",
    WORKOS_API_BASE_URL: "http://127.0.0.1:1",
    LOG_LEVEL: "error",
  });
  const { app, store } = createApp(config);
  const existing = store.saveCredentials({
    access: "old-access",
    refresh: "old-refresh",
    expires: Date.now() + 60_000,
    email: "existing@outlook.com",
  });

  const response = await app.request("/admin/api/accounts/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      accounts: [
        {
          email: "existing@outlook.com",
          access: "new-access",
          refresh: "new-refresh",
          expires: Date.now() + 3_600_000,
          tokenType: "Bearer",
          provider: "cline",
          label: "updated",
        },
        {
          email: "new@outlook.com",
          access: "raw-access",
          refresh: "raw-refresh",
          expires: 1_789_989_005,
        },
        {
          email: "not-an-email",
          access: "bad",
          refresh: "bad",
          expires: Date.now(),
        },
      ],
    }),
  });

  assert.equal(response.status, 200);
  const result = (await response.json()) as {
    imported: number;
    updated: number;
    skipped: number;
    total: number;
    errors: Array<{ index: number; email: string | null; reason: string }>;
  };
  assert.deepEqual(
    {
      imported: result.imported,
      updated: result.updated,
      skipped: result.skipped,
      total: result.total,
    },
    { imported: 1, updated: 1, skipped: 1, total: 3 },
  );
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.index, 2);

  const updated = store.get(existing.id);
  assert.equal(updated?.access, "new-access");
  assert.equal(updated?.label, "updated");

  const imported = store.list().find((account) => account.email === "new@outlook.com");
  assert.ok(imported);
  assert.equal(imported.access, "raw-access");
  assert.equal(imported.refresh, "raw-refresh");
  assert.equal(imported.expires, 1_789_989_005_000);
  assert.equal(imported.tokenType, "Bearer");
  assert.equal(imported.provider, "cline");
});
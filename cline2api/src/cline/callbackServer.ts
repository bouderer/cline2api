/**
 * Short-lived localhost OAuth callback server.
 *
 * The callback flow is optional because it requires the operator's browser to
 * reach the gateway host. Device-code remains the default for remote/Docker
 * deployments. The server only binds to 127.0.0.1 and reserves a single route.
 */
import { createServer, type Server } from "node:http";
import { ClineAuthError } from "./auth.js";

const DEFAULT_CALLBACK_HOST = "127.0.0.1";
const DEFAULT_CALLBACK_PATH = "/auth";
const DEFAULT_CALLBACK_PORTS = Array.from({ length: 11 }, (_, index) => 48801 + index);
const DEFAULT_CALLBACK_TIMEOUT_MS = 5 * 60 * 1000;

export interface CallbackServerOptions {
  host?: string;
  path?: string;
  ports?: readonly number[];
  timeoutMs?: number;
  successHtml?: string;
}

export interface LocalCallbackServer {
  readonly port: number;
  readonly callbackUrl: string;
  readonly code: Promise<string>;
  close(): Promise<void>;
}

const SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Cline authentication successful</title>
  <style>
    body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0}
    main{max-width:420px;padding:32px;text-align:center}
    h1{font-size:22px;margin:0 0 12px}p{margin:0;color:#94a3b8;line-height:1.6}
  </style>
</head>
<body><main><h1>Authentication successful</h1><p>You can close this window and return to cline2api.</p></main></body>
</html>`;

function listenOnce(server: Server, port: number, host: string): Promise<NodeJS.ErrnoException | null> {
  return new Promise((resolve) => {
    const onError = (error: NodeJS.ErrnoException) => {
      server.off("listening", onListening);
      resolve(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve(null);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ port, host, exclusive: true });
  });
}

export async function startLocalCallbackServer(
  options: CallbackServerOptions = {},
): Promise<LocalCallbackServer> {
  const host = options.host ?? DEFAULT_CALLBACK_HOST;
  const callbackPath = options.path ?? DEFAULT_CALLBACK_PATH;
  const ports = options.ports ?? DEFAULT_CALLBACK_PORTS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CALLBACK_TIMEOUT_MS;

  for (const port of ports) {
    let server: Server | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let settled = false;
    let closed = false;
    let resolveCode!: (code: string) => void;
    let rejectCode!: (error: Error) => void;

    const code = new Promise<string>((resolve, reject) => {
      resolveCode = resolve;
      rejectCode = reject;
    });
    // Mark the rejection as observed even if a caller never awaits `code`.
    // The original promise still rejects normally for LoginService.
    code.catch(() => {});

    const clearTimer = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const closeResources = (): Promise<void> => {
      clearTimer();
      if (closed || !server) return Promise.resolve();
      closed = true;
      const closing = server;
      server = null;
      return new Promise((resolve) => {
        closing.close(() => resolve());
        closing.closeAllConnections?.();
      });
    };

    const settleReject = (error: Error) => {
      if (settled) return;
      settled = true;
      rejectCode(error);
    };

    server = createServer((request, response) => {
      let requestUrl: URL;
      try {
        requestUrl = new URL(request.url ?? "", `http://${host}:${port}`);
      } catch {
        response.statusCode = 400;
        response.end("Invalid callback request");
        return;
      }

      if (request.method !== "GET" || requestUrl.pathname !== callbackPath) {
        response.statusCode = 404;
        response.end("Not found");
        return;
      }

      const error = requestUrl.searchParams.get("error");
      if (error) {
        response.statusCode = 400;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end(`Authentication failed: ${error}`);
        settleReject(
          new ClineAuthError(`OAuth callback returned an error: ${error}`, {
            errorCode: error,
          }),
        );
        void closeResources();
        return;
      }

      const authCode = requestUrl.searchParams.get("code")?.trim();
      if (!authCode) {
        response.statusCode = 400;
        response.setHeader("Content-Type", "text/plain; charset=utf-8");
        response.end("Missing authorization code");
        return;
      }

      if (!settled) {
        settled = true;
        resolveCode(authCode);
      }
      response.statusCode = 200;
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(options.successHtml ?? SUCCESS_HTML);
    });

    const bindError = await listenOnce(server, port, host);
    if (bindError) {
      server = null;
      if (bindError.code === "EADDRINUSE") continue;
      throw bindError;
    }

    const address = server.address();
    const boundPort = typeof address === "object" && address ? address.port : port;

    timer = setTimeout(() => {
      settleReject(
        new ClineAuthError("Callback authorization timed out", {
          errorCode: "expired_token",
        }),
      );
      void closeResources();
    }, timeoutMs);

    const callbackUrl = `http://${host}:${boundPort}${callbackPath}`;
    return {
      port: boundPort,
      callbackUrl,
      code,
      close: async () => {
        settleReject(new ClineAuthError("Callback authorization cancelled"));
        await closeResources();
      },
    };
  }

  throw new ClineAuthError("No local callback port is available", {
    errorCode: "port_unavailable",
  });
}
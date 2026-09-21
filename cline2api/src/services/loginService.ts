/**
 * Interactive login sessions for the admin UI.
 *
 * Device-code remains the portable default. The optional localhost callback
 * mode requires the browser to reach 127.0.0.1 on the gateway host (or a
 * forwarded/mapped port) and is therefore never selected implicitly.
 */
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import {
  ClineAuthError,
  exchangeAuthorizationCode,
  pollDeviceAuth,
  registerWorkOSTokens,
  startCallbackAuth,
  startDeviceAuth,
} from "../cline/auth.js";
import { startLocalCallbackServer, type LocalCallbackServer } from "../cline/callbackServer.js";
import { defaultClineHeaders } from "../cline/constants.js";
import type { ClineCredentials, DeviceAuthSession } from "../cline/types.js";

export type LoginMode = "device" | "callback";
export type LoginStatus = "pending" | "approved" | "failed" | "expired" | "cancelled";

const CALLBACK_LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

export interface LoginSessionView {
  id: string;
  mode: LoginMode;
  status: LoginStatus;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  qrSvg: string;
  expiresAt: number;
  pollIntervalSeconds: number;
  email: string | null;
  accountId: string | null;
  error: string | null;
}

interface LoginSession {
  id: string;
  mode: LoginMode;
  status: LoginStatus;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | null;
  qrSvg: string;
  email: string | null;
  accountId: string | null;
  error: string | null;
  expiresAt: number;
  pollIntervalSeconds: number;
  deviceCode: string | null;
  controller: AbortController;
  callback: LocalCallbackServer | null;
  createdAt: number;
}

export class LoginService {
  private readonly sessions = new Map<string, LoginSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: AccountStore,
    private readonly logger: Logger,
  ) {}

  private authOptions(provider = "cline") {
    return {
      clineApiBaseUrl: this.config.clineApiBaseUrl,
      workosApiBaseUrl: this.config.workosApiBaseUrl,
      clientId: this.config.workOsClientId,
      requestTimeoutMs: this.config.requestTimeoutMs,
      headers: defaultClineHeaders({
        clientName: this.config.clientName,
        clientVersion: this.config.clientVersion,
        platform: this.config.platform,
        platformVersion: this.config.platformVersion,
        coreVersion: this.config.coreVersion,
        taskId: "login",
      }),
      provider,
    };
  }

  /** Purge finished sessions older than an hour to keep memory flat. */
  private sweep(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (session.status !== "pending" && session.createdAt < cutoff) this.sessions.delete(id);
    }
  }

  async start(mode: LoginMode = "device"): Promise<LoginSessionView> {
    this.sweep();
    const id = randomUUID();
    const controller = new AbortController();
    let session: LoginSession;

    if (mode === "callback") {
      const callback = await startLocalCallbackServer({ timeoutMs: CALLBACK_LOGIN_TIMEOUT_MS });
      try {
        const verificationUri = await startCallbackAuth(
          this.authOptions("MicrosoftOAuth"),
          callback.callbackUrl,
        );
        const qrSvg = await QRCode.toString(verificationUri, {
          type: "svg",
          margin: 1,
          width: 220,
        });
        session = {
          id,
          mode,
          status: "pending",
          userCode: String(callback.port),
          verificationUri,
          verificationUriComplete: verificationUri,
          qrSvg,
          email: null,
          accountId: null,
          error: null,
          expiresAt: Date.now() + CALLBACK_LOGIN_TIMEOUT_MS,
          pollIntervalSeconds: 2,
          deviceCode: null,
          controller,
          callback,
          createdAt: Date.now(),
        };
      } catch (error) {
        await callback.close().catch(() => {});
        throw error;
      }
    } else {
      const device: DeviceAuthSession = await startDeviceAuth({
        workosApiBaseUrl: this.config.workosApiBaseUrl,
        clientId: this.config.workOsClientId,
        requestTimeoutMs: this.config.requestTimeoutMs,
      });
      const verificationUriComplete = device.verificationUriComplete ?? device.verificationUri;
      const qrSvg = await QRCode.toString(verificationUriComplete, {
        type: "svg",
        margin: 1,
        width: 220,
      });
      session = {
        id,
        mode,
        status: "pending",
        userCode: device.userCode,
        verificationUri: device.verificationUri,
        verificationUriComplete: device.verificationUriComplete ?? null,
        qrSvg,
        email: null,
        accountId: null,
        error: null,
        expiresAt: Date.now() + device.expiresInSeconds * 1000,
        pollIntervalSeconds: device.pollIntervalSeconds,
        deviceCode: device.deviceCode,
        controller,
        callback: null,
        createdAt: Date.now(),
      };
    }

    this.sessions.set(id, session);
    this.logger.info(`${mode} login started`, {
      sessionId: id,
      expiresAt: session.expiresAt,
    });
    void this.run(session);
    return this.view(session);
  }
  private async completeLogin(session: LoginSession): Promise<ClineCredentials> {
    let credentials: ClineCredentials;
    if (session.mode === "device") {
      if (!session.deviceCode) throw new Error("Device login session has no device code");
      const tokens = await pollDeviceAuth({
        workosApiBaseUrl: this.config.workosApiBaseUrl,
        clientId: this.config.workOsClientId,
        deviceCode: session.deviceCode,
        expiresInSeconds: Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000)),
        pollIntervalSeconds: session.pollIntervalSeconds,
        requestTimeoutMs: this.config.requestTimeoutMs,
        signal: session.controller.signal,
      });
      credentials = await registerWorkOSTokens(tokens, this.authOptions("cline"));
    } else {
      const callback = session.callback;
      if (!callback) throw new Error("Callback login session has no local server");
      const exchanged = await exchangeAuthorizationCode(
        await callback.code,
        callback.callbackUrl,
        this.authOptions("MicrosoftOAuth"),
      );
      credentials =
        exchanged.credentials ??
        (await registerWorkOSTokens(exchanged, this.authOptions("MicrosoftOAuth")));
    }
    return credentials;
  }

  private async run(session: LoginSession): Promise<void> {
    try {
      const credentials = await this.completeLogin(session);
      const saved = this.store.saveCredentials(credentials, {
        provider: session.mode === "callback" ? "MicrosoftOAuth" : "cline",
      });
      session.status = "approved";
      session.email = credentials.email ?? null;
      session.accountId = saved.id;
      this.logger.info(`${session.mode} login approved and account stored`, {
        sessionId: session.id,
        accountId: saved.id,
        email: saved.email,
      });
    } catch (error) {
      if (session.controller.signal.aborted) {
        session.status = "cancelled";
        return;
      }
      const message = (error as Error).message;
      session.status =
        error instanceof ClineAuthError && error.errorCode === "expired_token"
          ? "expired"
          : "failed";
      session.error = message;
      this.logger.warn(`${session.mode} login failed`, {
        sessionId: session.id,
        error: message,
      });
    } finally {
      await session.callback?.close().catch(() => {});
    }
  }
  get(id: string): LoginSessionView | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.status === "pending" && Date.now() > session.expiresAt) {
      session.status = "expired";
      session.error = session.mode === "callback" ? "callback session expired" : "device code expired";
      session.controller.abort();
      void session.callback?.close().catch(() => {});
    }
    return this.view(session);
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.status = "cancelled";
    session.controller.abort();
    void session.callback?.close().catch(() => {});
    return true;
  }

  private view(session: LoginSession): LoginSessionView {
    return {
      id: session.id,
      mode: session.mode,
      status: session.status,
      userCode: session.userCode,
      verificationUri: session.verificationUri,
      verificationUriComplete: session.verificationUriComplete,
      qrSvg: session.qrSvg,
      expiresAt: session.expiresAt,
      pollIntervalSeconds: session.pollIntervalSeconds,
      email: session.email,
      accountId: session.accountId,
      error: session.error,
    };
  }
}
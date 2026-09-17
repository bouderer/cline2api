/**
 * Interactive device-code login sessions for the admin UI.
 *
 * One session == one human-approved account. The gateway never creates
 * accounts on its own: it requests a WorkOS device code, the operator opens
 * the verification URL and approves, and only then are the resulting Cline
 * credentials persisted.
 */
import { randomUUID } from "node:crypto";
import QRCode from "qrcode";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import {
  ClineAuthError,
  pollDeviceAuth,
  registerWorkOSTokens,
  startDeviceAuth,
} from "../cline/auth.js";
import { defaultClineHeaders } from "../cline/constants.js";
import type { DeviceAuthSession } from "../cline/types.js";

export type LoginStatus = "pending" | "approved" | "failed" | "expired" | "cancelled";

export interface LoginSessionView {
  id: string;
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
  device: DeviceAuthSession;
  status: LoginStatus;
  qrSvg: string;
  email: string | null;
  accountId: string | null;
  error: string | null;
  expiresAt: number;
  controller: AbortController;
  createdAt: number;
}

export class LoginService {
  private readonly sessions = new Map<string, LoginSession>();

  constructor(
    private readonly config: AppConfig,
    private readonly store: AccountStore,
    private readonly logger: Logger,
  ) {}

  private authOptions() {
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
      provider: "cline",
    };
  }

  /** Purge finished sessions older than an hour to keep memory flat. */
  private sweep(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, session] of this.sessions) {
      if (session.status !== "pending" && session.createdAt < cutoff) this.sessions.delete(id);
    }
  }

  async start(): Promise<LoginSessionView> {
    this.sweep();
    const device = await startDeviceAuth({
      workosApiBaseUrl: this.config.workosApiBaseUrl,
      clientId: this.config.workOsClientId,
      requestTimeoutMs: this.config.requestTimeoutMs,
    });
    const id = randomUUID();
    const controller = new AbortController();
    const verificationUriComplete = device.verificationUriComplete ?? device.verificationUri;
    const qrSvg = await QRCode.toString(verificationUriComplete, {
      type: "svg",
      margin: 1,
      width: 220,
    });
    const session: LoginSession = {
      id,
      device,
      status: "pending",
      qrSvg,
      email: null,
      accountId: null,
      error: null,
      expiresAt: Date.now() + device.expiresInSeconds * 1000,
      controller,
      createdAt: Date.now(),
    };
    this.sessions.set(id, session);
    this.logger.info("device login started", { sessionId: id, expiresInSeconds: device.expiresInSeconds });
    void this.run(session);
    return this.view(session);
  }

  private async run(session: LoginSession): Promise<void> {
    try {
      const tokens = await pollDeviceAuth({
        workosApiBaseUrl: this.config.workosApiBaseUrl,
        clientId: this.config.workOsClientId,
        deviceCode: session.device.deviceCode,
        expiresInSeconds: session.device.expiresInSeconds,
        pollIntervalSeconds: session.device.pollIntervalSeconds,
        requestTimeoutMs: this.config.requestTimeoutMs,
        signal: session.controller.signal,
      });
      const credentials = await registerWorkOSTokens(tokens, this.authOptions());
      const saved = this.store.saveCredentials(credentials, { provider: "cline" });
      session.status = "approved";
      session.email = credentials.email ?? null;
      session.accountId = saved.id;
      this.logger.info("device login approved and account stored", {
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
      this.logger.warn("device login failed", { sessionId: session.id, error: message });
    }
  }

  get(id: string): LoginSessionView | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.status === "pending" && Date.now() > session.expiresAt) {
      session.status = "expired";
      session.error = "device code expired";
      session.controller.abort();
    }
    return this.view(session);
  }

  cancel(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;
    session.status = "cancelled";
    session.controller.abort();
    return true;
  }

  private view(session: LoginSession): LoginSessionView {
    return {
      id: session.id,
      status: session.status,
      userCode: session.device.userCode,
      verificationUri: session.device.verificationUri,
      verificationUriComplete: session.device.verificationUriComplete ?? null,
      qrSvg: session.qrSvg,
      expiresAt: session.expiresAt,
      pollIntervalSeconds: session.device.pollIntervalSeconds,
      email: session.email,
      accountId: session.accountId,
      error: session.error,
    };
  }
}

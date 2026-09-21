/** Credential and identity shapes, mirroring the official @cline/core contract. */
export interface ClineAuthUser {
  subject?: string | null;
  email?: string | null;
  name?: string | null;
  clineUserId?: string | null;
  accounts?: string[] | null;
}

/** Raw `data` object returned by /api/v1/auth/{register,refresh}. */
export interface ClineTokenResponseData {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAt: string;
  userInfo: ClineAuthUser;
}

export interface ClineTokenResponse {
  success: boolean;
  data: ClineTokenResponseData;
}

/** Rich credential object, same semantics as ClineOAuthCredentials. */
export interface ClineCredentials {
  access: string;
  refresh: string;
  /** Expiry as epoch milliseconds. */
  expires: number;
  accountId?: string;
  email?: string;
  metadata?: {
    provider?: string;
    tokenType?: string;
    userInfo?: ClineAuthUser;
    [key: string]: unknown;
  };
}

export interface StoredAccount {
  id: string;
  label: string | null;
  email: string | null;
  accountId: string | null;
  access: string;
  refresh: string;
  expires: number;
  tokenType: string;
  provider: string;
  createdAt: number;
  updatedAt: number;
  disabled: boolean;
  lastError: string | null;
}

export interface DeviceAuthSession {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export interface TokenResolution {
  forceRefresh?: boolean;
  refreshBufferMs?: number;
  retryableTokenGraceMs?: number;
}

/**
 * Headless device-code login: `npm run login`.
 *
 * Prints the verification URL and user code, waits for browser approval, then
 * stores the resulting credentials. This is the same flow the admin UI drives,
 * just without a browser on the server.
 */
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { AccountStore } from "../store.js";
import { pollDeviceAuth, registerWorkOSTokens, startDeviceAuth } from "../cline/auth.js";
import { defaultClineHeaders } from "../cline/constants.js";

async function main(): Promise<number> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel, config.proxyApiKeys);
  const store = new AccountStore(config.dataDir, logger);

  const device = await startDeviceAuth({
    workosApiBaseUrl: config.workosApiBaseUrl,
    clientId: config.workOsClientId,
    requestTimeoutMs: config.requestTimeoutMs,
  });

  const url = device.verificationUriComplete ?? device.verificationUri;
  console.log("");
  console.log("  在浏览器中打开下面的链接并确认登录：");
  console.log(`  ${url}`);
  console.log("");
  console.log(`  设备码：${device.userCode}`);
  console.log("");
  console.log(`  （${device.expiresInSeconds} 秒内有效，Ctrl+C 可取消）`);
  console.log("");

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.on("SIGINT", onSigint);
  try {
    const tokens = await pollDeviceAuth({
      workosApiBaseUrl: config.workosApiBaseUrl,
      clientId: config.workOsClientId,
      deviceCode: device.deviceCode,
      expiresInSeconds: device.expiresInSeconds,
      pollIntervalSeconds: device.pollIntervalSeconds,
      requestTimeoutMs: config.requestTimeoutMs,
      signal: controller.signal,
    });
    const credentials = await registerWorkOSTokens(tokens, {
      clineApiBaseUrl: config.clineApiBaseUrl,
      workosApiBaseUrl: config.workosApiBaseUrl,
      clientId: config.workOsClientId,
      requestTimeoutMs: config.requestTimeoutMs,
      headers: defaultClineHeaders({
        clientName: config.clientName,
        clientVersion: config.clientVersion,
        platform: config.platform,
        platformVersion: config.platformVersion,
        coreVersion: config.coreVersion,
        taskId: "cli-login",
      }),
      provider: "cline",
    });
    const saved = store.saveCredentials(credentials, { provider: "cline" });
    console.log(`登录成功：${saved.email ?? saved.id}`);
    console.log(`账号已保存到 ${store.filePath}（当前共 ${store.count()} 个）`);
    console.log(`令牌到期：${new Date(saved.expires).toLocaleString()}`);
    return 0;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`登录失败：${(error as Error).message}`);
    process.exit(1);
  });

/** `npm run accounts` — list stored accounts without revealing any token. */
import { loadConfig } from "../config.js";
import { createLogger } from "../logger.js";
import { AccountStore } from "../store.js";

const config = loadConfig();
const store = new AccountStore(config.dataDir, createLogger("error", config.proxyApiKeys));
const accounts = store.list();

if (accounts.length === 0) {
  console.log("还没有账号。运行 `npm run login` 登录一个。");
  process.exit(0);
}

console.log(`${accounts.length} 个账号（${store.filePath}）：`);
for (const account of accounts) {
  const remainingMinutes = Math.round((account.expires - Date.now()) / 60000);
  const state = account.disabled ? `需重新登录（${account.lastError ?? "unknown"}）` : "可用";
  console.log(
    [
      `  - ${account.email ?? account.id}`,
      state,
      `令牌${remainingMinutes > 0 ? `剩余 ${remainingMinutes} 分钟` : "已过期"}`,
      account.accountId ? `id=${account.accountId}` : "",
    ]
      .filter(Boolean)
      .join(" · "),
  );
}

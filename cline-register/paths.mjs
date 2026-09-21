/**
 * paths.mjs — cline-register 内部路径解析（完全自包含，零外部项目依赖）
 *
 * 目录约定（仓库根 = cline2api/）：
 *   cline2api/                 仓库根
 *   ├── cline2api/             生产级网关（TypeScript）
 *   └── cline-register/        本注册机
 *
 * 环境变量按以下顺序加载（后者只补前者没有的键）：
 *   1. cline-register/.env
 *   2. 仓库根 .env
 *   3. 网关目录 .env（cline2api/cline2api/.env）
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

export const REGISTER_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(REGISTER_DIR, "..");
export const GATEWAY_DIR = path.join(REPO_ROOT, "cline2api");
export const __dirname = REGISTER_DIR;

function loadDotenv(file, { prefer = false } = {}) {
  try {
    if (!file || !fs.existsSync(file)) return;
    const parsed = dotenv.parse(fs.readFileSync(file));
    for (const [key, value] of Object.entries(parsed)) {
      const cur = process.env[key];
      const empty = cur == null || String(cur).trim() === "";
      if (prefer) {
        if (String(value ?? "").trim() !== "") process.env[key] = value;
      } else if (empty) {
        process.env[key] = value;
      }
    }
  } catch {}
}

loadDotenv(path.join(REGISTER_DIR, ".env"));
loadDotenv(path.join(REPO_ROOT, ".env"));
loadDotenv(path.join(GATEWAY_DIR, ".env"));

export function firstExisting(cands, fallback) {
  for (const p of cands) {
    try { if (p && fs.existsSync(p)) return p; } catch {}
  }
  return fallback || cands[0];
}

export function dataPath(...parts) {
  return path.join(REGISTER_DIR, "data", ...parts);
}

export const CONFIG_DIR = path.join(REGISTER_DIR, "config");
export const LOG_DIR = dataPath("logs");

export function mailPath(name) {
  return firstExisting(
    [path.join(CONFIG_DIR, "mail", name)],
    path.join(CONFIG_DIR, "mail", name),
  );
}

export function poolPath(f) {
  if (!f) return f;
  if (path.isAbsolute(f)) return f;
  return firstExisting(
    [path.join(CONFIG_DIR, "proxy", f), path.join(REGISTER_DIR, f)],
    path.join(CONFIG_DIR, "proxy", f),
  );
}

export const WORKSPACE_DIR = REGISTER_DIR;

try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}

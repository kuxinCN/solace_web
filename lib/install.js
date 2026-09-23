/**
 * 安装状态管理。
 *
 * 「是否已安装」用两个信号判断，任一成立都算已安装：
 *   1. 文件锁 config/installed.lock —— 不依赖数据库，所以数据库配错时依然能判断；
 *   2. 数据库里已经有管理员账号 —— 防止有人只删了锁文件就重装。
 *
 * 想重新安装（比如换了数据库、或者验证器丢了）：在 .env.local 里设置
 *   ALLOW_REINSTALL=1
 * 重启服务后 /install 会进入「重新安装模式」，或者直接删掉
 * config/installed.lock（若数据库里已有管理员，还需要清空 admin_users）。
 */
import fs from "node:fs";
import path from "node:path";
import { getBootstrapState } from "./admin-auth";
import { describeDbError } from "./db";

export const CONFIG_DIR = path.join(process.cwd(), "config");
export const LOCK_PATH = path.join(CONFIG_DIR, "installed.lock");

export function reinstallAllowed() {
  return String(process.env.ALLOW_REINSTALL || "").trim() === "1";
}

export function readInstallLock() {
  try {
    const raw = fs.readFileSync(LOCK_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeInstallLock(info) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const payload = {
    ...info,
    installedAt: new Date().toISOString(),
  };
  fs.writeFileSync(LOCK_PATH, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return payload;
}

export function removeInstallLock() {
  try {
    fs.unlinkSync(LOCK_PATH);
    return true;
  } catch {
    return false;
  }
}

/**
 * 站点是否「曾经成功配置过数据库」。
 * 用安装锁或 config/db.json 的存在来判断——这两个文件都只会在一次成功之后产生。
 * 注意不要用 .env.local 里的 DB_* 判断：用户第一次手写配置、写错了很常见，
 * 那种情况必须允许他自由重配，否则会被自己锁死。
 *
 * 边界说明：这两个文件都在服务器上，能删掉它们的人本来就已经有服务器权限。
 * 因此「把 lock 和 db.json 都删掉、同时数据库又连不上」时会退化成全新安装，
 * 这属于可接受的取舍（远端陌生人做不到删服务器文件）。
 */
export function isProvisioned() {
  if (readInstallLock()) return true;
  try {
    fs.accessSync(path.join(CONFIG_DIR, "db.json"));
    return true;
  } catch {
    return false;
  }
}

/** 目录可写性检测：安装过程要写 config/db.json 和安装锁 */
export function checkEnvironment() {
  const nodeMajor = Number(String(process.versions.node).split(".")[0]);
  let configWritable = false;
  let configError = "";

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    const probe = path.join(CONFIG_DIR, ".write-test");
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    configWritable = true;
  } catch (err) {
    configError = err?.message || String(err);
  }

  return {
    node: process.versions.node,
    nodeOk: nodeMajor >= 18,
    nodeHint: nodeMajor >= 18 ? "" : "需要 Node.js 18.17 以上",
    platform: `${process.platform} ${process.arch}`,
    nodeEnv: process.env.NODE_ENV || "development",
    configDir: "config",
    configWritable,
    configError,
    reinstallAllowed: reinstallAllowed(),
  };
}

/**
 * 返回安装状态：
 *   { installed, source, lock, dbReady, needsSetup, dbError, dbVersion }
 */
export async function getInstallState() {
  const lock = readInstallLock();
  if (lock) {
    return { installed: true, source: "lock", lock, dbReady: true, needsSetup: false, dbError: "" };
  }

  try {
    const state = await getBootstrapState();
    if (state.dbReady && !state.needsSetup) {
      // 数据库里已有管理员，但没有锁文件（可能被手工删掉了）
      return {
        installed: true,
        source: "database",
        lock: null,
        dbReady: true,
        needsSetup: false,
        dbError: "",
      };
    }
    return {
      installed: false,
      source: "",
      lock: null,
      dbReady: state.dbReady,
      needsSetup: state.needsSetup,
      dbError: state.error || "",
    };
  } catch (err) {
    return {
      installed: false,
      source: "",
      lock: null,
      dbReady: false,
      needsSetup: false,
      dbError: describeDbError(err),
    };
  }
}

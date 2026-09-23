/**
 * MySQL 连接池。
 *
 * 数据库连接信息不能存在数据库里（先有鸡还是先有蛋），所以它单独存在
 * 服务器上的 config/db.json（不提交到仓库）。读取顺序：
 *   config/db.json(后台保存过的) > 环境变量(.env.local) > 默认值
 *
 * 后台「数据库」页面保存新配置时：先真实测试连接，成功才写文件并热切换连接池，
 * 失败则保持原配置不动，避免把线上弄挂。
 */
import fs from "node:fs";
import path from "node:path";
import mysql from "mysql2/promise";

const CONFIG_PATH = path.join(process.cwd(), "config", "db.json");

const DEFAULT_CONFIG = {
  host: "127.0.0.1",
  port: 3306,
  user: "root",
  password: "",
  database: "solace",
  connectionLimit: 5,
};

let pool = null;
let activeConfig = null;

function cleanText(value, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.trim();
}

function normalize(input) {
  const source = input && typeof input === "object" ? input : {};
  const config = { ...DEFAULT_CONFIG };

  config.host = cleanText(source.host, DEFAULT_CONFIG.host) || DEFAULT_CONFIG.host;
  config.user = cleanText(source.user, DEFAULT_CONFIG.user) || DEFAULT_CONFIG.user;
  config.database =
    cleanText(source.database, DEFAULT_CONFIG.database) || DEFAULT_CONFIG.database;
  // 密码允许为空字符串，也允许包含空格，所以不做 trim
  config.password = typeof source.password === "string" ? source.password : "";

  const port = Number(source.port);
  if (Number.isInteger(port) && port > 0 && port < 65536) config.port = port;

  const limit = Number(source.connectionLimit);
  if (Number.isInteger(limit) && limit >= 1 && limit <= 20) {
    config.connectionLimit = limit;
  }

  return config;
}

function readConfigFile() {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function configFromEnv() {
  const env = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  };
  const hasAny = Object.values(env).some(
    (value) => typeof value === "string" && value.trim() !== ""
  );
  return hasAny ? env : null;
}

/** 当前生效的连接配置（含密码，勿直接返回给前端） */
export function getDatabaseConfig() {
  if (!activeConfig) {
    const fileConfig = readConfigFile();
    activeConfig = normalize(fileConfig || configFromEnv());
  }
  return { ...activeConfig };
}

/** 返回给前端用的配置：去掉密码，只告诉「是否已设置密码」 */
export function getPublicDatabaseConfig() {
  const config = getDatabaseConfig();
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    connectionLimit: config.connectionLimit,
    hasPassword: config.password !== "",
    configFilePath: path.relative(process.cwd(), CONFIG_PATH),
  };
}

export function getPool() {
  if (pool) return pool;
  const config = getDatabaseConfig();
  pool = mysql.createPool({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    waitForConnections: true,
    connectionLimit: config.connectionLimit,
    queueLimit: 0,
    connectTimeout: 8000,
    charset: "utf8mb4",
    timezone: "local",
    dateStrings: true,
  });
  return pool;
}

/** 执行 SQL，返回结果行数组 */
export async function query(sql, params = []) {
  const [rows] = await getPool().execute(sql, params);
  return rows;
}

/** 执行 SQL，返回 { affectedRows, insertId } */
export async function execute(sql, params = []) {
  const [result] = await getPool().execute(sql, params);
  return result;
}

/** 事务：fn(connection) 里用 conn.execute */
export async function withTransaction(fn) {
  const conn = await getPool().getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    try {
      await conn.rollback();
    } catch {}
    throw err;
  } finally {
    conn.release();
  }
}

/** 用一份独立短连接测试配置是否可用（不会影响正在运行的连接池） */
export async function testConnection(input) {
  const config = normalize(input || getDatabaseConfig());
  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      connectTimeout: 8000,
      charset: "utf8mb4",
    });
    const [rows] = await conn.query("SELECT VERSION() AS version");
    return { ok: true, version: rows?.[0]?.version || "" };
  } catch (err) {
    return { ok: false, error: describeDbError(err) };
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {}
    }
  }
}

export function describeDbError(err) {
  const code = err?.code ? String(err.code) : "";
  const message = err?.message ? String(err.message) : String(err);
  const hints = {
    ER_ACCESS_DENIED_ERROR: "用户名或密码不正确",
    ER_BAD_DB_ERROR: "数据库不存在（请先在宝塔里创建该数据库）",
    ECONNREFUSED: "无法连接，请检查地址和端口，以及 MySQL 是否允许该 IP 访问",
    ETIMEDOUT: "连接超时，请检查服务器防火墙 / 宝塔安全组是否放行 3306",
    ENOTFOUND: "主机名无法解析",
    ER_NO_SUCH_TABLE: "缺少数据表，请先导入 db/schema.sql",
  };
  const hint = hints[code];
  return hint ? `${message}（${hint}）` : message;
}

/** 测试通过后写入 config/db.json 并热切换连接池 */
export async function applyDatabaseConfig(input) {
  const config = normalize(input);
  const test = await testConnection(config);
  if (!test.ok) {
    const error = new Error(test.error);
    error.code = "DB_TEST_FAILED";
    throw error;
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });

  const previous = pool;
  pool = null;
  activeConfig = config;
  if (previous) {
    try {
      await previous.end();
    } catch {}
  }

  return { config, version: test.version };
}

/**
 * 用给定的账号连接 MySQL（先不指定数据库），把目标库创建出来。
 * 这样在安装向导里填 root 账号就能一步建库，不必先去宝塔面板手动建。
 * 注意：CREATE DATABASE 不能用占位符，所以库名必须严格白名单校验。
 */
export async function ensureDatabase(input) {
  const config = normalize(input);

  if (!/^[A-Za-z0-9_]{1,64}$/.test(config.database)) {
    return { ok: false, error: "数据库名只能包含字母、数字和下划线（1-64 位）" };
  }

  let conn = null;
  try {
    conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      connectTimeout: 8000,
      charset: "utf8mb4",
    });
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${config.database}\` ` +
        "DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci"
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: describeDbError(err) };
  } finally {
    if (conn) {
      try {
        await conn.end();
      } catch {}
    }
  }
}

/** 仅供脚本/调试使用：关闭连接池 */
export async function closePool() {
  const previous = pool;
  pool = null;
  if (previous) {
    try {
      await previous.end();
    } catch {}
  }
}

export { CONFIG_PATH };

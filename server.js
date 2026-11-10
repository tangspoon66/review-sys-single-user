const express = require("express");
const busboy = require("busboy");
const mammoth = require("mammoth");
const QRCode = require("qrcode");
const Database = require("better-sqlite3");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, ".env"));

const app = express();
const PORT = process.env.PORT || 5177;
const HOST = process.env.HOST || "0.0.0.0";
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const AUTH_COOKIE = "szstm_admin_session";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const RESERVATION_TTL_MS = 2 * 60 * 1000;

function configuredDir(envName, fallback) {
  const value = String(process.env[envName] || "").trim();
  return value ? path.resolve(value) : fallback;
}

const ROOT = __dirname;
// Storage paths are not URL roots. DATA_DIR / UPLOAD_DIR only move files on disk.
const DATA_DIR = configuredDir("DATA_DIR", path.join(ROOT, "data"));
const UPLOAD_DIR = configuredDir("UPLOAD_DIR", path.join(ROOT, "uploads"));
const IMAGE_DIR = path.join(UPLOAD_DIR, "images");
const ASSET_DIR = path.join(ROOT, "assets");
const DB_PATH = path.join(DATA_DIR, "app.db");
const EXHAUSTED_MESSAGE = "次数已用完";

for (const dir of [DATA_DIR, UPLOAD_DIR, IMAGE_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    used INTEGER NOT NULL DEFAULT 0,
    reserved_until TEXT,
    reservation_token TEXT
  );

  CREATE TABLE IF NOT EXISTS sections (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`);

function tableColumns(table) {
  return db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name);
}

function ensureColumn(table, column, definition) {
  if (tableColumns(table).includes(column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

ensureColumn("images", "reserved_until", "TEXT");
ensureColumn("images", "reservation_token", "TEXT");
db.exec("CREATE INDEX IF NOT EXISTS idx_images_reservation ON images(reservation_token)");

const defaultSettings = {
  imageMode: "random",
  fixedImageId: "",
  publicBaseUrl: "",
};

const getSettingStmt = db.prepare("SELECT value FROM settings WHERE key = ?");
const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

for (const [key, value] of Object.entries(defaultSettings)) {
  if (!getSettingStmt.get(key)) setSettingStmt.run(key, value);
}

function createTextsTable() {
  db.exec(`
    CREATE TABLE texts (
      id TEXT PRIMARY KEY,
      section_id TEXT NOT NULL,
      content TEXT NOT NULL,
      normalized TEXT NOT NULL,
      source_name TEXT,
      created_at TEXT NOT NULL,
      used_at TEXT,
      used INTEGER NOT NULL DEFAULT 0,
      reserved_until TEXT,
      reservation_token TEXT,
      UNIQUE(section_id, normalized),
      FOREIGN KEY (section_id) REFERENCES sections(id)
    );
    CREATE INDEX IF NOT EXISTS idx_texts_claim ON texts(section_id, used, created_at);
    CREATE INDEX IF NOT EXISTS idx_texts_reservation ON texts(reservation_token);
  `);
}

function migrateTextsTable() {
  const exists = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'texts'").get();
  if (!exists) {
    createTextsTable();
    setSettingStmt.run("schema_version", "2");
    return;
  }

  const columns = tableColumns("texts");
  if (!columns.includes("section_id")) {
    const cleared = db.prepare("SELECT COUNT(*) AS count FROM texts").get().count;
    db.exec("DROP TABLE texts");
    createTextsTable();
    setSettingStmt.run("schema_version", "2");
    setSettingStmt.run("legacy_texts_cleared", String(cleared));
    console.log(`[migrate] cleared ${cleared} legacy texts; they were not copied into a default section`);
    return;
  }

  ensureColumn("texts", "reserved_until", "TEXT");
  ensureColumn("texts", "reservation_token", "TEXT");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_texts_claim ON texts(section_id, used, created_at);
    CREATE INDEX IF NOT EXISTS idx_texts_reservation ON texts(reservation_token);
  `);
  if (!getSettingStmt.get("schema_version")) setSettingStmt.run("schema_version", "2");
}

migrateTextsTable();
migrateMojibakeMetadata();

function now() {
  return new Date().toISOString();
}

function uid() {
  return crypto.randomBytes(8).toString("hex");
}

function extFromName(name = "") {
  return path.extname(name).toLowerCase();
}

function sanitizeBase(name = "file") {
  return name
    .replace(/\.[^.]+$/, "")
    .replace(/[^\w\u4e00-\u9fa5-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "file";
}

function normalizeText(content) {
  return content.trim().replace(/\s+/g, " ");
}

function cleanTextContent(content) {
  return String(content || "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim().replace(/[^\S\n]+/g, " "))
    .filter(Boolean)
    .join("\n");
}

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
}

function cleanId(value) {
  const id = String(value || "").trim();
  return /^[a-f0-9]{8,32}$/i.test(id) ? id : "";
}

function cleanToken(value) {
  const token = String(value || "").trim();
  return /^[a-f0-9]{32,128}$/i.test(token) ? token : "";
}

function normalizeSectionName(value) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, 40);
}

function normalizeSortOrder(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-100000, Math.min(100000, Math.trunc(number)));
}

function normalizeEnabled(value, fallback = 1) {
  if (value === undefined) return fallback ? 1 : 0;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === 1 || value === "1" || value === "true") return 1;
  if (value === 0 || value === "0" || value === "false") return 0;
  return fallback ? 1 : 0;
}

function looksLikeMojibake(value = "") {
  return /(?:Ã|Â|â|æ|ç|è|é|å|ä|ö|ï¿½|�)/.test(value);
}

function repairMojibake(value = "") {
  if (!looksLikeMojibake(value)) return value;
  const repaired = Buffer.from(value, "latin1").toString("utf8");
  return repaired.includes("�") ? value : repaired;
}

function uploadFilename(name = "file") {
  return repairMojibake(String(name || "file"));
}

function safeEqual(a = "", b = "") {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function authConfigured() {
  return Boolean(ADMIN_USER && ADMIN_PASSWORD && SESSION_SECRET);
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) return [part, ""];
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      }),
  );
}

function signSession(payload) {
  return crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
}

function createSessionToken(username) {
  const payload = Buffer.from(JSON.stringify({
    username,
    exp: Date.now() + SESSION_TTL_MS,
    nonce: uid(),
  })).toString("base64url");
  return `${payload}.${signSession(payload)}`;
}

function verifySessionToken(token = "") {
  if (!authConfigured()) return false;
  const [payload, signature] = token.split(".");
  if (!payload || !signature || !safeEqual(signature, signSession(payload))) return false;

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return data.username === ADMIN_USER && Number(data.exp) > Date.now();
  } catch {
    return false;
  }
}

function cookieOptions(req) {
  const secure = process.env.COOKIE_SECURE === "true" || req.headers["x-forwarded-proto"] === "https";
  return [
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
    secure ? "Secure" : "",
  ].filter(Boolean).join("; ");
}

function clearAuthCookie(res) {
  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

function adminAuth(req, res, next) {
  const wantsPage = req.originalUrl.startsWith("/admin.html");

  if (!authConfigured()) {
    if (wantsPage) return res.redirect("/login.html?error=config");
    return res.status(503).json({ ok: false, message: "后台登录尚未配置" });
  }

  if (verifySessionToken(parseCookies(req)[AUTH_COOKIE])) return next();

  if (wantsPage) return res.redirect("/login.html");
  res.status(401).json({ ok: false, message: "请先登录后台" });
}

const NUMBERED_HEADING = /^(\d{1,3})(?:[\s\u3000]+|[.、．)）][\s\u3000]*)([^#\s\u3000].{0,23})$/;

// Documents like "01　遛娃妈妈 / 标题 / 正文 / #话题" spread one copy over several
// paragraphs under a short numbered heading; the heading is a label, not copy.
function splitNumberedEntries(raw) {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim());
  const entries = [];
  let current = null;
  for (const line of lines) {
    const heading = line.match(NUMBERED_HEADING);
    if (heading) {
      current = { number: Number(heading[1]), lines: [] };
      entries.push(current);
    } else if (current && line) {
      current.lines.push(line);
    }
  }

  if (entries.length < 2) return null;
  const sequential = entries.every((entry, index) => index === 0 || entry.number === entries[index - 1].number + 1);
  if (!sequential || entries.some((entry) => entry.lines.length === 0)) return null;
  return entries.map((entry) => entry.lines.join("\n"));
}

function splitTextBlocks(raw) {
  const numbered = splitNumberedEntries(raw);
  if (numbered) return numbered.map(cleanTextContent).filter(Boolean);

  return raw
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/g)
    .map((block) => block.trim())
    .filter(Boolean)
    .flatMap((block) => {
      const lines = block
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);

      if (lines.length > 1 && lines.every((line) => line.length < 120)) {
        return lines.map((line) => line.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean);
      }

      return [block.replace(/^[-*•\d.)\s]+/, "").trim()];
    })
    .map(normalizeText)
    .filter(Boolean);
}

async function extractTextFromUpload(file) {
  const ext = extFromName(uploadFilename(file.filename));
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    return result.value || "";
  }

  return file.buffer.toString("utf8");
}

function migrateMojibakeMetadata() {
  const updateTexts = db.transaction(() => {
    const rows = db.prepare("SELECT id, source_name FROM texts WHERE source_name IS NOT NULL").all();
    for (const row of rows) {
      const fixed = repairMojibake(row.source_name);
      if (fixed !== row.source_name) {
        db.prepare("UPDATE texts SET source_name = ? WHERE id = ?").run(fixed, row.id);
      }
    }
  });

  const updateImages = db.transaction(() => {
    const rows = db.prepare("SELECT id, original_name FROM images").all();
    for (const row of rows) {
      const fixed = repairMojibake(row.original_name);
      if (fixed !== row.original_name) {
        db.prepare("UPDATE images SET original_name = ? WHERE id = ?").run(fixed, row.id);
      }
    }
  });

  updateTexts();
  updateImages();
}

function getSettings() {
  const rows = db.prepare("SELECT key, value FROM settings").all();
  const settings = { ...defaultSettings };
  rows.forEach((row) => {
    settings[row.key] = row.value;
  });
  return settings;
}

function saveImageSettings(settings) {
  const mode = ["random", "fixed", "off"].includes(settings.imageMode) ? settings.imageMode : "random";
  setSettingStmt.run("imageMode", mode);
  setSettingStmt.run("fixedImageId", settings.fixedImageId || "");
}

function normalizePublicBase(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  return url.origin;
}

function savePublicBase(value) {
  const normalized = normalizePublicBase(value);
  if (normalized === null) {
    const error = new Error("公开地址需要以 http:// 或 https:// 开头，不要带路径、账号或问号");
    error.statusCode = 400;
    throw error;
  }
  setSettingStmt.run("publicBaseUrl", normalized);
}

function requestPublicOrigin(req) {
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwardedProto || req.protocol || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if (!host || !/^https?$/.test(proto)) return "";
  return `${proto}://${host}`;
}

function sectionEntryUrl(base, sectionId) {
  return `${String(base || "").replace(/\/+$/, "")}/?s=${sectionId}`;
}

function clearFixedImageIfNeeded(ids) {
  const settings = getSettings();
  if (settings.fixedImageId && ids.includes(settings.fixedImageId)) {
    setSettingStmt.run("fixedImageId", "");
  }
}

function releaseImageToken(token) {
  if (!token) return;
  db.prepare(`
    UPDATE images
    SET reserved_until = NULL, reservation_token = NULL
    WHERE reservation_token = ? AND used = 0
  `).run(token);
}

const insertTextStmt = db.prepare(`
  INSERT INTO texts (id, section_id, content, normalized, source_name, created_at)
  VALUES (@id, @sectionId, @content, @normalized, @sourceName, @createdAt)
`);

function addTexts(items, sourceName, sectionId) {
  let added = 0;
  let skipped = 0;
  const insertMany = db.transaction((contents) => {
    for (const content of contents) {
      const cleaned = cleanTextContent(content);
      const normalized = normalizeText(cleaned);
      if (!normalized) continue;
      try {
        insertTextStmt.run({
          id: uid(),
          sectionId,
          content: cleaned,
          normalized,
          sourceName: uploadFilename(sourceName),
          createdAt: now(),
        });
        added += 1;
      } catch (error) {
        if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
          skipped += 1;
        } else {
          throw error;
        }
      }
    }
  });

  insertMany(items);
  return { added, skipped };
}

const insertImageStmt = db.prepare(`
  INSERT INTO images (id, filename, original_name, mime_type, path, created_at)
  VALUES (@id, @filename, @originalName, @mimeType, @path, @createdAt)
`);

function addImages(files) {
  let added = 0;
  const inserted = [];
  const insertMany = db.transaction((imageFiles) => {
    for (const file of imageFiles) {
      const originalName = uploadFilename(file.filename);
      const ext = extFromName(originalName) || ".png";
      const base = sanitizeBase(originalName);
      const id = uid();
      const filename = `${Date.now()}-${uid()}-${base}${ext}`;
      const savePath = path.join(IMAGE_DIR, filename);
      const publicPath = `/uploads/images/${filename}`;
      fs.writeFileSync(savePath, file.buffer);

      const image = {
        id,
        filename,
        originalName,
        mimeType: file.mimeType,
        path: publicPath,
        createdAt: now(),
      };

      insertImageStmt.run(image);
      inserted.push({
        ...image,
        usedAt: "",
        used: false,
      });
      added += 1;
    }
  });

  insertMany(files);
  return { added, images: inserted };
}

function rowToText(row) {
  return {
    id: row.id,
    sectionId: row.section_id,
    content: row.content,
    sourceName: repairMojibake(row.source_name || ""),
    createdAt: row.created_at,
    usedAt: row.used_at || "",
    used: Boolean(row.used),
  };
}

function rowToImage(row) {
  return {
    id: row.id,
    filename: row.filename,
    originalName: repairMojibake(row.original_name),
    mimeType: row.mime_type,
    path: row.path,
    createdAt: row.created_at,
    usedAt: row.used_at || "",
    used: Boolean(row.used),
  };
}

function rowToSection(row) {
  return {
    id: row.id,
    name: row.name,
    sortOrder: row.sort_order,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    textTotal: Number(row.text_total || 0),
    textUnused: Number(row.text_unused || 0),
  };
}

const sectionSelectSql = `
  SELECT
    s.*,
    (SELECT COUNT(*) FROM texts t WHERE t.section_id = s.id) AS text_total,
    (SELECT COUNT(*) FROM texts t WHERE t.section_id = s.id AND t.used = 0) AS text_unused
  FROM sections s
`;

function getSectionRow(id) {
  return db.prepare(`${sectionSelectSql} WHERE s.id = ?`).get(id);
}

function reserveForSection(section) {
  const reserve = db.transaction(() => {
    const current = now();
    const text = db.prepare(`
      SELECT * FROM texts
      WHERE section_id = ?
        AND used = 0
        AND (reserved_until IS NULL OR reserved_until = '' OR reserved_until < ?)
      ORDER BY created_at ASC, id ASC
      LIMIT 1
    `).get(section.id, current);
    if (!text) return { text: null, unused: Number(section.text_unused) };

    const token = crypto.randomBytes(24).toString("hex");
    const until = new Date(Date.now() + RESERVATION_TTL_MS).toISOString();
    const locked = db.prepare(`
      UPDATE texts
      SET reserved_until = ?, reservation_token = ?
      WHERE id = ?
        AND used = 0
        AND (reserved_until IS NULL OR reserved_until = '' OR reserved_until < ?)
    `).run(until, token, text.id, current).changes;
    if (!locked) return { text: null, unused: Number(section.text_unused) };

    const settings = getSettings();
    let image = null;
    if (settings.imageMode === "fixed") {
      image = db.prepare("SELECT * FROM images WHERE id = ?").get(settings.fixedImageId)
        || db.prepare("SELECT * FROM images ORDER BY created_at ASC LIMIT 1").get()
        || null;
    } else if (settings.imageMode === "random") {
      const candidate = db.prepare(`
        SELECT * FROM images
        WHERE used = 0
          AND (reserved_until IS NULL OR reserved_until = '' OR reserved_until < ?)
        ORDER BY RANDOM()
        LIMIT 1
      `).get(current);
      if (candidate) {
        const imageLocked = db.prepare(`
          UPDATE images
          SET reserved_until = ?, reservation_token = ?
          WHERE id = ?
            AND used = 0
            AND (reserved_until IS NULL OR reserved_until = '' OR reserved_until < ?)
        `).run(until, token, candidate.id, current).changes;
        if (imageLocked) image = candidate;
      }
    }

    return {
      text,
      token,
      until,
      image,
      imageMode: settings.imageMode,
      unused: Number(section.text_unused),
    };
  });

  return reserve.immediate();
}

function previewSection(sectionId) {
  const section = getSectionRow(sectionId);
  if (!section) {
    return { status: 404, body: { ok: false, code: "missing", message: "这个入口无效" } };
  }
  if (!section.enabled) {
    return { status: 403, body: { ok: false, code: "disabled", message: "这个入口已停用" } };
  }

  const reserved = reserveForSection(section);
  if (!reserved.text) {
    const message = reserved.unused > 0 ? "文案正在被领取，请稍后重试" : EXHAUSTED_MESSAGE;
    return { status: 200, body: { ok: false, message, text: "", image: "" } };
  }

  return {
    status: 200,
    body: {
      ok: true,
      message: "ok",
      sectionId: section.id,
      sectionName: section.name,
      text: reserved.text.content,
      textId: reserved.text.id,
      reservationToken: reserved.token,
      expiresAt: reserved.until,
      image: reserved.image?.path || "",
      imageId: reserved.image?.id || "",
      imageMode: reserved.imageMode,
    },
  };
}

function commitReservation(textId, token) {
  const commit = db.transaction(() => {
    const text = db.prepare("SELECT * FROM texts WHERE id = ?").get(textId);
    if (!text || text.used || text.reservation_token !== token || !text.reserved_until) {
      return { ok: false, message: "文案已失效，请重新打开二维码" };
    }

    if (text.reserved_until < now()) {
      db.prepare(`
        UPDATE texts
        SET reserved_until = NULL, reservation_token = NULL
        WHERE id = ? AND used = 0
      `).run(textId);
      releaseImageToken(token);
      return { ok: false, message: "文案已失效，请重新打开二维码" };
    }

    const usedAt = now();
    const changed = db.prepare(`
      UPDATE texts
      SET used = 1, used_at = ?, reserved_until = NULL, reservation_token = NULL
      WHERE id = ? AND reservation_token = ? AND used = 0
    `).run(usedAt, textId, token).changes;
    if (!changed) return { ok: false, message: "文案已失效，请重新打开二维码" };

    const settings = getSettings();
    if (settings.imageMode === "random") {
      db.prepare(`
        UPDATE images
        SET used = 1, used_at = ?, reserved_until = NULL, reservation_token = NULL
        WHERE reservation_token = ? AND used = 0
      `).run(usedAt, token);
    } else {
      releaseImageToken(token);
    }

    return { ok: true, message: "ok" };
  });

  return commit.immediate();
}

function releaseReservation(textId, token) {
  const release = db.transaction(() => {
    db.prepare(`
      UPDATE texts
      SET reserved_until = NULL, reservation_token = NULL
      WHERE id = ? AND reservation_token = ? AND used = 0
    `).run(textId, token);
    releaseImageToken(token);
  });
  release.immediate();
}

function deleteImageFiles(rows) {
  for (const row of rows) {
    const filePath = path.join(IMAGE_DIR, row.filename);
    try {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } catch (error) {
      console.warn(`Failed to delete image file: ${filePath}`, error.message);
    }
  }
}

function serializeState(limit = 80, sectionId = "") {
  const listLimit = Math.max(20, Math.min(Number(limit) || 80, 200));
  const settings = getSettings();
  const counts = {
    textTotal: db.prepare("SELECT COUNT(*) AS count FROM texts").get().count,
    textUnused: db.prepare("SELECT COUNT(*) AS count FROM texts WHERE used = 0").get().count,
    imageTotal: db.prepare("SELECT COUNT(*) AS count FROM images").get().count,
    imageUnused: db.prepare("SELECT COUNT(*) AS count FROM images WHERE used = 0").get().count,
    sectionTotal: db.prepare("SELECT COUNT(*) AS count FROM sections").get().count,
    sectionEnabled: db.prepare("SELECT COUNT(*) AS count FROM sections WHERE enabled = 1").get().count,
  };
  const sections = db.prepare(`
    ${sectionSelectSql}
    ORDER BY s.sort_order ASC, s.created_at ASC, s.id ASC
  `).all().map(rowToSection);
  const requestedId = cleanId(sectionId);
  const texts = requestedId
    ? db.prepare("SELECT * FROM texts WHERE section_id = ? ORDER BY created_at DESC LIMIT ?").all(requestedId, listLimit).map(rowToText)
    : [];

  return {
    settings,
    counts,
    limit: listLimit,
    sectionId: requestedId,
    sections,
    texts,
    images: db.prepare("SELECT * FROM images ORDER BY created_at DESC LIMIT ?").all(listLimit).map(rowToImage),
  };
}

function createSection({ name, sortOrder, enabled }) {
  const id = uid();
  const timestamp = now();
  db.prepare(`
    INSERT INTO sections (id, name, sort_order, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, sortOrder, enabled, timestamp, timestamp);
  return rowToSection(getSectionRow(id));
}

function updateSection(id, { name, sortOrder, enabled }) {
  const existing = db.prepare("SELECT * FROM sections WHERE id = ?").get(id);
  if (!existing) return null;
  const nextName = name === undefined ? existing.name : name;
  const nextSort = sortOrder === undefined ? existing.sort_order : sortOrder;
  const nextEnabled = enabled === undefined ? existing.enabled : enabled;
  db.prepare(`
    UPDATE sections
    SET name = ?, sort_order = ?, enabled = ?, updated_at = ?
    WHERE id = ?
  `).run(nextName, nextSort, nextEnabled, now(), id);
  return rowToSection(getSectionRow(id));
}

function deleteSection(id) {
  const remove = db.transaction(() => {
    const existing = db.prepare("SELECT id FROM sections WHERE id = ?").get(id);
    if (!existing) return false;
    const tokens = db.prepare(`
      SELECT reservation_token
      FROM texts
      WHERE section_id = ? AND reservation_token IS NOT NULL AND reservation_token != ''
    `).all(id);
    for (const row of tokens) releaseImageToken(row.reservation_token);
    db.prepare("DELETE FROM texts WHERE section_id = ?").run(id);
    db.prepare("DELETE FROM sections WHERE id = ?").run(id);
    return true;
  });
  return remove.immediate();
}

async function readMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      defParamCharset: "utf8",
      limits: { fileSize: 30 * 1024 * 1024, files: 50 },
    });
    const fields = {};
    const files = [];

    bb.on("field", (name, value) => {
      fields[name] = value;
    });

    bb.on("file", (name, stream, info) => {
      const chunks = [];
      stream.on("data", (chunk) => chunks.push(chunk));
      stream.on("limit", () => reject(new Error(`File too large: ${info.filename}`)));
      stream.on("end", () => {
        files.push({
          fieldname: name,
          filename: info.filename,
          mimeType: info.mimeType,
          buffer: Buffer.concat(chunks),
        });
      });
    });

    bb.on("error", reject);
    bb.on("filesLimit", () => reject(new Error("单次上传图片太多，请分批上传")));
    bb.on("partsLimit", () => reject(new Error("单次上传内容太多，请分批上传")));
    bb.on("finish", () => resolve({ fields, files }));
    req.pipe(bb);
  });
}

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  next();
});
app.use(express.json({ limit: "2mb" }));
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});
app.use("/api/admin", adminAuth);

app.get("/api/auth/session", (req, res) => {
  res.json({ ok: true, authenticated: verifySessionToken(parseCookies(req)[AUTH_COOKIE]) });
});

app.post("/api/auth/login", (req, res) => {
  if (!authConfigured()) {
    return res.status(503).json({ ok: false, message: "后台登录尚未配置" });
  }

  const username = String(req.body?.username || "");
  const password = String(req.body?.password || "");
  if (!safeEqual(username, ADMIN_USER) || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ ok: false, message: "账号或密码不正确" });
  }

  res.setHeader("Set-Cookie", `${AUTH_COOKIE}=${encodeURIComponent(createSessionToken(username))}; ${cookieOptions(req)}`);
  res.json({ ok: true });
});

app.post("/api/auth/logout", (req, res) => {
  clearAuthCookie(res);
  res.json({ ok: true });
});

app.get("/api/sections", (req, res) => {
  res.json({ ok: false, message: "请扫描对应板块的二维码", sections: [] });
});

app.post("/api/sections/:id/preview", (req, res) => {
  const id = cleanId(req.params.id);
  if (!id) return res.status(400).json({ ok: false, code: "missing", message: "这个入口无效" });
  const previousTextId = cleanId(req.body?.previousTextId);
  const previousToken = cleanToken(req.body?.previousReservationToken);
  if (previousTextId && previousToken) releaseReservation(previousTextId, previousToken);
  const result = previewSection(id);
  res.status(result.status).json(result.body);
});

app.post("/api/claim", (req, res) => {
  const textId = cleanId(req.body?.textId);
  const token = cleanToken(req.body?.reservationToken);
  if (!textId || !token) return res.status(400).json({ ok: false, message: "缺少文案领取信息" });
  const result = commitReservation(textId, token);
  res.status(result.ok ? 200 : 409).json(result);
});

app.post("/api/claim/release", (req, res) => {
  const textId = cleanId(req.body?.textId);
  const token = cleanToken(req.body?.reservationToken);
  if (textId && token) releaseReservation(textId, token);
  res.json({ ok: true });
});

app.get("/api/next", (req, res) => {
  res.json({ ok: false, message: "请扫描对应板块的二维码", text: "", image: "" });
});

app.get("/api/admin/state", (req, res) => {
  res.json(serializeState(req.query.limit, req.query.sectionId));
});

app.post("/api/admin/settings", (req, res) => {
  try {
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "imageMode")) {
      const imageMode = typeof req.body.imageMode === "string" ? req.body.imageMode : "random";
      const fixedImageId = typeof req.body.fixedImageId === "string" ? req.body.fixedImageId : "";
      saveImageSettings({ imageMode, fixedImageId });
    }
    if (req.body && Object.prototype.hasOwnProperty.call(req.body, "publicBaseUrl")) {
      savePublicBase(req.body.publicBaseUrl);
    }
    res.json({ ok: true, settings: getSettings() });
  } catch (error) {
    res.status(error.statusCode || 400).json({ ok: false, message: error.message || "保存失败" });
  }
});

app.get("/api/admin/sections/:id/qr", async (req, res) => {
  try {
    const id = cleanId(req.params.id);
    const section = id ? db.prepare("SELECT id, name FROM sections WHERE id = ?").get(id) : null;
    if (!section) return res.status(404).json({ ok: false, message: "板块不存在" });

    const configured = normalizePublicBase(getSettings().publicBaseUrl);
    const base = configured || requestPublicOrigin(req);
    if (!base) return res.status(400).json({ ok: false, message: "请先设置站点公开地址" });

    const png = await QRCode.toBuffer(sectionEntryUrl(base, section.id), {
      type: "png",
      width: 512,
      margin: 1,
      errorCorrectionLevel: "M",
    });
    res.setHeader("Content-Type", "image/png");
    res.setHeader("Cache-Control", "no-store");
    if (req.query.download === "1") {
      const filename = encodeURIComponent(`${sanitizeBase(section.name) || "section"}-qr.png`);
      res.setHeader("Content-Disposition", `attachment; filename="section-qr.png"; filename*=UTF-8''${filename}`);
    }
    res.send(png);
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "二维码生成失败" });
  }
});

app.post("/api/admin/sections", (req, res) => {
  try {
    const name = normalizeSectionName(req.body?.name);
    if (!name) return res.status(400).json({ ok: false, message: "板块名称不能为空" });
    const sortOrder = normalizeSortOrder(req.body?.sortOrder);
    const enabled = normalizeEnabled(req.body?.enabled, 1);
    const section = createSection({ name, sortOrder, enabled });
    res.json({ ok: true, section });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ ok: false, message: "已有同名板块" });
    }
    res.status(400).json({ ok: false, message: error.message || "保存失败" });
  }
});

app.patch("/api/admin/sections/:id", (req, res) => {
  try {
    const id = cleanId(req.params.id);
    if (!id || !db.prepare("SELECT id FROM sections WHERE id = ?").get(id)) {
      return res.status(404).json({ ok: false, message: "板块不存在" });
    }

    const patch = {};
    if (req.body?.name !== undefined) {
      patch.name = normalizeSectionName(req.body.name);
      if (!patch.name) return res.status(400).json({ ok: false, message: "板块名称不能为空" });
    }
    if (req.body?.sortOrder !== undefined) patch.sortOrder = normalizeSortOrder(req.body.sortOrder);
    if (req.body?.enabled !== undefined) patch.enabled = normalizeEnabled(req.body.enabled, 1);
    const section = updateSection(id, patch);
    res.json({ ok: true, section });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return res.status(409).json({ ok: false, message: "已有同名板块" });
    }
    res.status(400).json({ ok: false, message: error.message || "保存失败" });
  }
});

app.delete("/api/admin/sections/:id", (req, res) => {
  const id = cleanId(req.params.id);
  if (!id || !deleteSection(id)) return res.status(404).json({ ok: false, message: "板块不存在" });
  res.json({ ok: true });
});

app.patch("/api/admin/texts/:id", (req, res) => {
  try {
    const id = cleanId(req.params.id);
    const content = cleanTextContent(req.body?.content);
    if (!id || !content) return res.status(400).json({ ok: false, message: "文案不能为空" });

    const existing = db.prepare("SELECT id FROM texts WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ ok: false, message: "文案不存在" });

    try {
      db.prepare("UPDATE texts SET content = ?, normalized = ? WHERE id = ?").run(content, normalizeText(content), id);
    } catch (error) {
      if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
        return res.status(409).json({ ok: false, message: "文案重复，已被系统拦截" });
      }
      throw error;
    }

    res.json({ ok: true, item: rowToText(db.prepare("SELECT * FROM texts WHERE id = ?").get(id)) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "update failed" });
  }
});

app.post("/api/admin/texts/bulk", (req, res) => {
  try {
    const action = String(req.body?.action || "");
    const ids = normalizeIds(req.body?.ids).map(cleanId).filter(Boolean);
    if (!ids.length) return res.status(400).json({ ok: false, message: "请先选择文案" });

    const run = db.transaction(() => {
      let changed = 0;
      for (const id of ids) {
        const row = db.prepare("SELECT reservation_token FROM texts WHERE id = ?").get(id);
        if (action === "delete") {
          releaseImageToken(row?.reservation_token);
          changed += db.prepare("DELETE FROM texts WHERE id = ?").run(id).changes;
        } else if (action === "reset") {
          releaseImageToken(row?.reservation_token);
          changed += db.prepare(`
            UPDATE texts
            SET used = 0, used_at = NULL, reserved_until = NULL, reservation_token = NULL
            WHERE id = ?
          `).run(id).changes;
        } else if (action === "mark-used") {
          releaseImageToken(row?.reservation_token);
          changed += db.prepare(`
            UPDATE texts
            SET used = 1, used_at = ?, reserved_until = NULL, reservation_token = NULL
            WHERE id = ?
          `).run(now(), id).changes;
        } else {
          throw new Error("不支持的批量操作");
        }
      }
      return changed;
    });

    res.json({ ok: true, changed: run.immediate(), counts: serializeState().counts });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "bulk failed" });
  }
});

app.patch("/api/admin/images/:id", (req, res) => {
  try {
    const id = cleanId(req.params.id);
    const originalName = String(req.body?.originalName || "").trim().slice(0, 160);
    if (!id || !originalName) return res.status(400).json({ ok: false, message: "图片名称不能为空" });

    const existing = db.prepare("SELECT id FROM images WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ ok: false, message: "图片不存在" });

    db.prepare("UPDATE images SET original_name = ? WHERE id = ?").run(originalName, id);
    res.json({ ok: true, item: rowToImage(db.prepare("SELECT * FROM images WHERE id = ?").get(id)) });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "update failed" });
  }
});

app.post("/api/admin/images/bulk", (req, res) => {
  try {
    const action = String(req.body?.action || "");
    const ids = normalizeIds(req.body?.ids).map(cleanId).filter(Boolean);
    if (!ids.length) return res.status(400).json({ ok: false, message: "请先选择图片" });

    const run = db.transaction(() => {
      let changed = 0;
      if (action === "delete") {
        const rows = ids
          .map((id) => db.prepare("SELECT * FROM images WHERE id = ?").get(id))
          .filter(Boolean);
        deleteImageFiles(rows);
        clearFixedImageIfNeeded(ids);
        for (const id of ids) {
          changed += db.prepare("DELETE FROM images WHERE id = ?").run(id).changes;
        }
        return changed;
      }

      for (const id of ids) {
        if (action === "reset") {
          changed += db.prepare(`
            UPDATE images
            SET used = 0, used_at = NULL, reserved_until = NULL, reservation_token = NULL
            WHERE id = ?
          `).run(id).changes;
        } else if (action === "mark-used") {
          changed += db.prepare(`
            UPDATE images
            SET used = 1, used_at = ?, reserved_until = NULL, reservation_token = NULL
            WHERE id = ?
          `).run(now(), id).changes;
        } else {
          throw new Error("不支持的批量操作");
        }
      }
      return changed;
    });

    res.json({ ok: true, changed: run(), counts: serializeState().counts });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "bulk failed" });
  }
});

app.post("/api/admin/upload-texts", async (req, res) => {
  try {
    const { fields, files } = await readMultipart(req);
    const sectionId = cleanId(fields.sectionId);
    if (!sectionId || !db.prepare("SELECT id FROM sections WHERE id = ?").get(sectionId)) {
      return res.status(400).json({ ok: false, message: "请先选择板块" });
    }

    let added = 0;
    let skipped = 0;

    if (typeof fields.text === "string" && fields.text.trim()) {
      const result = addTexts(splitTextBlocks(fields.text), "paste", sectionId);
      added += result.added;
      skipped += result.skipped;
    }

    for (const file of files) {
      const raw = await extractTextFromUpload(file);
      const result = addTexts(splitTextBlocks(raw), file.filename, sectionId);
      added += result.added;
      skipped += result.skipped;
    }

    res.json({ ok: true, added, skipped, total: serializeState().counts.textTotal, sectionId });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "upload failed" });
  }
});

app.post("/api/admin/upload-images", async (req, res) => {
  const startedAt = Date.now();
  console.log(`[upload-images] start content-length=${req.headers["content-length"] || "unknown"}`);
  res.on("finish", () => {
    console.log(`[upload-images] finish status=${res.statusCode} duration=${Date.now() - startedAt}ms`);
  });

  try {
    const { files } = await readMultipart(req);
    const images = files.filter((file) => file.mimeType.startsWith("image/"));
    if (!images.length) return res.status(400).json({ ok: false, message: "没有收到可上传的图片" });
    const result = addImages(images);
    res.json({ ok: true, added: result.added, images: result.images, total: serializeState().counts.imageTotal });
  } catch (error) {
    res.status(400).json({ ok: false, message: error.message || "upload failed" });
  }
});

const PUBLIC_FILE_CACHE = "public, max-age=0";
const ASSET_CACHE = "public, max-age=2592000, immutable";
const IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".heic", ".heif", ".tif", ".tiff", ".jfif", ".jpe",
]);
const PUBLIC_ROOT_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/login.html", "login.html"],
  ["/styles.css", "styles.css"],
  ["/script.js", "script.js"],
]);

function decodePathFully(pathname) {
  let current = pathname;
  for (let i = 0; i < 8; i += 1) {
    if (!/%[0-9a-fA-F]{2}/.test(current)) return current;
    let decoded;
    try {
      decoded = decodeURIComponent(current);
    } catch {
      return null;
    }
    if (decoded.includes("\0")) return null;
    if (decoded === current) return current;
    current = decoded;
  }
  return /%[0-9a-fA-F]{2}/.test(current) ? null : current;
}

function canonicalRequestPath(req) {
  const raw = String(req.originalUrl || "");
  if (!raw || raw.includes("\0") || /%00/i.test(raw)) return { error: 400 };
  const cut = raw.search(/[?#]/);
  const pathOnly = cut === -1 ? raw : raw.slice(0, cut);
  if (!pathOnly.startsWith("/")) return { error: 400 };

  const decoded = decodePathFully(pathOnly);
  if (decoded == null) return { error: 400 };
  if (/[\u0000-\u001f\u007f]/.test(decoded)) return { error: 400 };

  const parts = [];
  for (const segment of decoded.replace(/\\/g, "/").split("/")) {
    if (segment === "" || segment === ".") continue;
    // Dot segments are rejected instead of resolved so a public prefix cannot be walked out of.
    if (segment === "..") return { error: 400 };
    parts.push(segment);
  }
  return { pathname: parts.length ? `/${parts.join("/")}` : "/" };
}

function isRealFileInside(rootDir, segments) {
  let rootReal;
  try {
    rootReal = fs.realpathSync(rootDir);
  } catch {
    return null;
  }
  const candidate = path.resolve(rootReal, ...segments);
  let real;
  try {
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  const relative = path.relative(rootReal, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  const relativeParts = relative.split(path.sep);
  if (relativeParts.some((part) => !part || part === ".." || part === "." || part.startsWith("."))) return null;
  let stat;
  try {
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  return stat.isFile() ? real : null;
}

function sendDiskFile(res, filePath, cacheControl) {
  res.setHeader("Cache-Control", cacheControl);
  res.sendFile(filePath, { dotfiles: "deny", acceptRanges: true }, (error) => {
    if (!error || res.headersSent) return;
    res.setHeader("Cache-Control", "no-store");
    res.status(404).end();
  });
}

function sendMappedRootFile(res, basename, cacheControl) {
  const real = isRealFileInside(ROOT, [basename]);
  if (!real || path.basename(real) !== basename) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).end();
    return;
  }
  sendDiskFile(res, real, cacheControl);
}

function sendTreeFile(res, rootDir, pathname, prefix, cacheControl) {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return false;
  const rest = pathname.slice(prefix.length + 1);
  const segments = rest.split("/").filter(Boolean);
  if (!segments.length || segments.some((segment) => segment === "." || segment === ".." || segment.startsWith("."))) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).end();
    return true;
  }
  const extension = path.extname(segments[segments.length - 1]).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).end();
    return true;
  }
  const real = isRealFileInside(rootDir, segments);
  if (!real) {
    res.setHeader("Cache-Control", "no-store");
    res.status(404).end();
    return true;
  }
  sendDiskFile(res, real, cacheControl);
  return true;
}

// The project root holds the database, source, and secrets. Only this allowlist is static.
function servePublic(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  if (pathname === "/favicon.ico") {
    res.status(204).end();
    return true;
  }

  const rootFile = PUBLIC_ROOT_FILES.get(pathname);
  if (rootFile) {
    sendMappedRootFile(res, rootFile, PUBLIC_FILE_CACHE);
    return true;
  }

  if (pathname === "/admin.html") {
    adminAuth(req, res, () => sendMappedRootFile(res, "admin.html", "private, no-store"));
    return true;
  }

  if (pathname === "/assets" || pathname.startsWith("/assets/")) {
    return sendTreeFile(res, ASSET_DIR, pathname, "/assets", ASSET_CACHE);
  }

  if (pathname === "/uploads/images" || pathname.startsWith("/uploads/images/")) {
    return sendTreeFile(res, IMAGE_DIR, pathname, "/uploads/images", PUBLIC_FILE_CACHE);
  }

  return false;
}

app.use((req, res, next) => {
  const canonical = canonicalRequestPath(req);
  if (canonical.error) {
    res.setHeader("Cache-Control", "no-store");
    res.status(canonical.error).end();
    return;
  }

  const { pathname } = canonical;
  if (pathname === "/api" || pathname.startsWith("/api/")) return next();
  if (servePublic(req, res, pathname)) return;

  res.setHeader("Cache-Control", "no-store");
  res.status(404).end();
});

if (require.main === module) {
  app.listen(PORT, HOST, () => {
    console.log(`Server running at http://${HOST}:${PORT}`);
  });
}

module.exports = { app };

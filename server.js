const express = require("express");
const busboy = require("busboy");
const mammoth = require("mammoth");
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
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const IMAGE_DIR = path.join(UPLOAD_DIR, "images");
const DB_PATH = path.join(DATA_DIR, "app.db");

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

  CREATE TABLE IF NOT EXISTS texts (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    normalized TEXT NOT NULL UNIQUE,
    source_name TEXT,
    created_at TEXT NOT NULL,
    used_at TEXT,
    used INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS images (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL,
    used_at TEXT,
    used INTEGER NOT NULL DEFAULT 0
  );
`);

const defaultSettings = {
  imageMode: "random",
  fixedImageId: "",
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

function normalizeIds(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((id) => String(id || "").trim()).filter(Boolean))];
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

function splitTextBlocks(raw) {
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

function saveSettings(settings) {
  const mode = ["random", "fixed", "off"].includes(settings.imageMode) ? settings.imageMode : "random";
  setSettingStmt.run("imageMode", mode);
  setSettingStmt.run("fixedImageId", settings.fixedImageId || "");
}

function clearFixedImageIfNeeded(ids) {
  const settings = getSettings();
  if (settings.fixedImageId && ids.includes(settings.fixedImageId)) {
    setSettingStmt.run("fixedImageId", "");
  }
}

const insertTextStmt = db.prepare(`
  INSERT INTO texts (id, content, normalized, source_name, created_at)
  VALUES (@id, @content, @normalized, @sourceName, @createdAt)
`);

function addTexts(items, sourceName) {
  let added = 0;
  let skipped = 0;
  const insertMany = db.transaction((contents) => {
    for (const content of contents) {
      const normalized = normalizeText(content);
      if (!normalized) continue;
      try {
        insertTextStmt.run({
          id: uid(),
          content: normalized,
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

const buildResponse = db.transaction(() => {
  const text = db.prepare("SELECT * FROM texts WHERE used = 0 ORDER BY created_at ASC LIMIT 1").get();
  if (!text) {
    return { ok: false, message: "次数已用完", text: "", image: "" };
  }

  const settings = getSettings();
  let image = null;

  if (settings.imageMode === "fixed") {
    image =
      db.prepare("SELECT * FROM images WHERE id = ?").get(settings.fixedImageId) ||
      db.prepare("SELECT * FROM images ORDER BY created_at ASC LIMIT 1").get();
  }

  if (settings.imageMode === "random") {
    image = db.prepare("SELECT * FROM images WHERE used = 0 ORDER BY RANDOM() LIMIT 1").get();
  }

  const usedAt = now();
  db.prepare("UPDATE texts SET used = 1, used_at = ? WHERE id = ?").run(usedAt, text.id);

  if (image && settings.imageMode === "random") {
    db.prepare("UPDATE images SET used = 1, used_at = ? WHERE id = ?").run(usedAt, image.id);
  }

  return {
    ok: true,
    message: "ok",
    text: text.content,
    image: image?.path || "",
    textId: text.id,
    imageId: image?.id || "",
    imageMode: settings.imageMode,
  };
});

function serializeState(limit = 80) {
  const listLimit = Math.max(20, Math.min(Number(limit) || 80, 200));
  const settings = getSettings();
  const counts = {
    textTotal: db.prepare("SELECT COUNT(*) AS count FROM texts").get().count,
    textUnused: db.prepare("SELECT COUNT(*) AS count FROM texts WHERE used = 0").get().count,
    imageTotal: db.prepare("SELECT COUNT(*) AS count FROM images").get().count,
    imageUnused: db.prepare("SELECT COUNT(*) AS count FROM images WHERE used = 0").get().count,
  };

  return {
    settings,
    counts,
    limit: listLimit,
    texts: db.prepare("SELECT * FROM texts ORDER BY created_at DESC LIMIT ?").all(listLimit).map(rowToText),
    images: db.prepare("SELECT * FROM images ORDER BY created_at DESC LIMIT ?").all(listLimit).map(rowToImage),
  };
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

app.use(express.json({ limit: "2mb" }));
app.use("/assets", express.static(path.join(ROOT, "assets"), {
  immutable: true,
  maxAge: "30d",
}));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use("/admin.html", adminAuth);
app.use("/api/admin", adminAuth);
app.get("/favicon.ico", (req, res) => res.status(204).end());
app.use(express.static(ROOT, { extensions: ["html"] }));

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

app.get("/api/next", (req, res) => {
  res.json(buildResponse());
});

app.get("/api/admin/state", (req, res) => {
  res.json(serializeState(req.query.limit));
});

app.post("/api/admin/settings", (req, res) => {
  const imageMode = typeof req.body?.imageMode === "string" ? req.body.imageMode : "random";
  const fixedImageId = typeof req.body?.fixedImageId === "string" ? req.body.fixedImageId : "";
  saveSettings({ imageMode, fixedImageId });
  res.json({ ok: true, settings: getSettings() });
});

app.patch("/api/admin/texts/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
    const content = normalizeText(String(req.body?.content || ""));
    if (!id || !content) return res.status(400).json({ ok: false, message: "文案不能为空" });

    const existing = db.prepare("SELECT id FROM texts WHERE id = ?").get(id);
    if (!existing) return res.status(404).json({ ok: false, message: "文案不存在" });

    try {
      db.prepare("UPDATE texts SET content = ?, normalized = ? WHERE id = ?").run(content, content, id);
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
    const ids = normalizeIds(req.body?.ids);
    if (!ids.length) return res.status(400).json({ ok: false, message: "请先选择文案" });

    const run = db.transaction(() => {
      let changed = 0;
      for (const id of ids) {
        if (action === "delete") {
          changed += db.prepare("DELETE FROM texts WHERE id = ?").run(id).changes;
        } else if (action === "reset") {
          changed += db.prepare("UPDATE texts SET used = 0, used_at = NULL WHERE id = ?").run(id).changes;
        } else if (action === "mark-used") {
          changed += db.prepare("UPDATE texts SET used = 1, used_at = ? WHERE id = ?").run(now(), id).changes;
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

app.patch("/api/admin/images/:id", (req, res) => {
  try {
    const id = String(req.params.id || "").trim();
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
    const ids = normalizeIds(req.body?.ids);
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
          changed += db.prepare("UPDATE images SET used = 0, used_at = NULL WHERE id = ?").run(id).changes;
        } else if (action === "mark-used") {
          changed += db.prepare("UPDATE images SET used = 1, used_at = ? WHERE id = ?").run(now(), id).changes;
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
    let added = 0;
    let skipped = 0;

    if (typeof fields.text === "string" && fields.text.trim()) {
      const result = addTexts(splitTextBlocks(fields.text), "paste");
      added += result.added;
      skipped += result.skipped;
    }

    for (const file of files) {
      const raw = await extractTextFromUpload(file);
      const result = addTexts(splitTextBlocks(raw), file.filename);
      added += result.added;
      skipped += result.skipped;
    }

    res.json({ ok: true, added, skipped, total: serializeState().counts.textTotal });
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

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT}`);
});

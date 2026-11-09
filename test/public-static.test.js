const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const repoRoot = path.join(__dirname, "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "review-sys-static-"));
const uploadDir = path.join(tempRoot, "uploads");
const imageDir = path.join(uploadDir, "images");

process.env.DATA_DIR = path.join(tempRoot, "db");
process.env.UPLOAD_DIR = uploadDir;
process.env.ADMIN_USER = "static-test-user";
process.env.ADMIN_PASSWORD = "static-test-password";
process.env.SESSION_SECRET = "static-test-session-secret-value";
process.env.COOKIE_SECURE = "false";
process.env.HOST = "127.0.0.1";

const { app } = require("../server");

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const UNICODE_IMAGE = "板块.png";
const MARKERS = [
  ["db", "SENTINEL_DB_BYTES"],
  ["wal", "SENTINEL_WAL_BYTES"],
  ["shm", "SENTINEL_SHM_BYTES"],
  ["password-file", "SENTINEL_PASSWORD_FILE"],
  ["env", "SENTINEL_ENV_SECRET"],
  ["backup", "SENTINEL_SOURCE_BACKUP"],
  ["upload-secret", "SENTINEL_UPLOAD_SECRET"],
  ["upload-html", "SENTINEL_HTML_UPLOAD"],
  ["server-source", "better-sqlite3"],
  ["env-example", "replace_with_strong_password"],
  ["package-name", "hermess-agent"],
  ["sqlite-header", "SQLite format 3"],
  ["test-password", process.env.ADMIN_PASSWORD],
  ["test-session", process.env.SESSION_SECRET],
];

const HIDDEN_PATHS = [
  "/server.js",
  "/server.js/",
  "/./server.js",
  "/Server.js",
  "/SERVER.JS",
  "/server.js.bak",
  "/package.json",
  "/package-lock.json",
  "/Dockerfile",
  "/docker-compose.yml",
  "/README.md",
  "/.env",
  "/.env.example",
  "/.env.local",
  "/.gitignore",
  "/.dockerignore",
  "/.git/HEAD",
  "/.git/config",
  "/data/app.db",
  "/data/app.db-wal",
  "/data/app.db-shm",
  "/data/passwords.txt",
  "/data",
  "/data/",
  "/DATA/app.db",
  "/Data/App.db",
  "/uploads/secret.txt",
  "/uploads/images/app.db",
  "/uploads/images/page.html",
  "/uploads/images/link.png",
  "/assets/escape.png",
  "/node_modules/express/package.json",
  "/node_modules/better-sqlite3/package.json",
  "/admin",
  "/admin.html.bak",
  "/backup/app.db",
  "/etc/passwd",
  "/server.js?download=1",
  "/data/app.db?download=1",
  "/data/app.db&x=1",
  "/server%2ejs",
  "/%73erver.js",
  "/data%2fapp.db",
  "/data%2Fapp.db",
  "/data/%2fapp.db",
  "/%2eenv",
  "/%2eenv.example",
  "/.env%00.html",
  "/server.js%00",
  "/server.js%00.png",
  "/server.js%0a",
  "/server.js%0d%0a",
  "/server.js%20",
  "/server.js%3b",
  "/server.js%23",
  "/%252eenv",
  "/%252e%252e/server.js",
  "/assets/%2e%2e/server.js",
  "/assets/%2e%2e%2fserver.js",
  "/assets/%252e%252e/server.js",
  "/assets/%252e%252e%252fserver.js",
  "/assets/..%2fserver.js",
  "/assets/../server.js",
  "/assets/../../server.js",
  "/assets/../data/app.db",
  "/assets/logo-white.png/../../server.js",
  "/assets/logo-white.png%2f..%2f..%2fserver.js",
  "/assets/%2e%2e/%2e%2e/data/app.db",
  "/uploads/../server.js",
  "/uploads/images/../../server.js",
  "/uploads/images/../../../server.js",
  "/uploads/images/%2e%2e/%2e%2e/data/app.db",
  "/uploads/images/ok.png/../../data/app.db",
  "/uploads/images/..%2f..%2fserver.js",
  "/index.html/../server.js",
  "/login.html/../.env",
  "/styles.css/../../server.js",
  "/script.js/../data/app.db",
  "/favicon.ico/../server.js",
  "/%2e%2e/server.js",
  "/%2e%2e/%2e%2e/server.js",
  "/data/../server.js",
  "/data/./../server.js",
  "//server.js",
  "///server.js",
  "/.//server.js",
  "/assets//../server.js",
  "/assets%5c..%5cserver.js",
  "/assets/..%5cserver.js",
  "/%5c../server.js",
  "/cgi-bin/.%2e/.%2e/server.js",
  "/cgi-bin/.%2e/%2e%2e/server.js",
  "/assets/....//server.js",
  "/assets/..;/server.js",
  "/%c0%ae%c0%ae/server.js",
  "/assets/%c0%ae%c0%ae/server.js",
  "/static/../server.js",
  "/public/../server.js",
  "/data/app.db%00.png",
  "/data/app.db%2f..%2fserver.js",
  "/data/app.db%3b.png",
  "/%2e%2e%2fdata%2fapp.db",
  "/uploads/images/%2e%2e/%2e%2e/%2eenv",
  "/admin.html/../server.js",
  "/admin.html/../data/app.db",
  "/index.html%00",
  "/styles.css%00",
  "/assets/logo-white.png%00.png",
  "/assets/logo-white.png/..%2f..%2fdata/app.db-wal",
  `/uploads/images/${encodeURIComponent(UNICODE_IMAGE)}/../../server.js`,
];

const created = [];
let server;
let port = 0;
let privatePrefixes = [];

function writeNew(file, contents) {
  if (fs.existsSync(file)) throw new Error(`refusing to overwrite ${file}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
  created.push(file);
}

function linkNew(target, linkPath) {
  if (fs.existsSync(linkPath)) throw new Error(`refusing to overwrite ${linkPath}`);
  fs.symlinkSync(target, linkPath);
  created.push(linkPath);
}

function decodeChunked(body) {
  const out = [];
  let offset = 0;
  while (offset < body.length) {
    const lineEnd = body.indexOf("\r\n", offset);
    if (lineEnd === -1) break;
    const sizeText = body.slice(offset, lineEnd).toString("latin1").split(";")[0];
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) break;
    if (size === 0) break;
    const start = lineEnd + 2;
    out.push(body.subarray(start, start + size));
    offset = start + size + 2;
  }
  return Buffer.concat(out);
}

function request(method, rawPath, { headers = {}, body = null } = {}) {
  if (/[\u0000\r\n]/.test(rawPath)) {
    return Promise.reject(new Error(`test path contains raw control characters: ${rawPath}`));
  }
  const payload = body == null ? null : Buffer.from(body);
  const lines = [
    `${method} ${rawPath} HTTP/1.1`,
    "Host: 127.0.0.1",
    "Connection: close",
  ];
  for (const [key, value] of Object.entries(headers)) lines.push(`${key}: ${value}`);
  if (payload) lines.push(`Content-Length: ${payload.length}`);

  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    const chunks = [];
    let received = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method} ${rawPath} timed out`));
    }, 5000);
    const fail = (error) => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    socket.on("error", fail);
    socket.on("connect", () => {
      socket.write(`${lines.join("\r\n")}\r\n\r\n`);
      if (payload) socket.write(payload);
    });
    socket.on("data", (chunk) => {
      received += chunk.length;
      if (received > 2 * 1024 * 1024) {
        fail(new Error(`${method} ${rawPath} response exceeded 2MB`));
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks);
      const headerEnd = raw.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        reject(new Error(`${method} ${rawPath} returned no HTTP response`));
        return;
      }
      const headerText = raw.subarray(0, headerEnd).toString("latin1");
      const headerLines = headerText.split("\r\n");
      const status = Number(headerLines[0].split(" ")[1]);
      const parsed = new Map();
      for (const line of headerLines.slice(1)) {
        const index = line.indexOf(":");
        if (index === -1) continue;
        const key = line.slice(0, index).trim().toLowerCase();
        const value = line.slice(index + 1).trim();
        if (!parsed.has(key)) parsed.set(key, []);
        parsed.get(key).push(value);
      }
      let responseBody = raw.subarray(headerEnd + 4);
      const encoding = (parsed.get("transfer-encoding") || []).join(",");
      if (/chunked/i.test(encoding)) responseBody = decodeChunked(responseBody);
      socket.end();
      resolve({ status, headers: parsed, body: responseBody });
    });
  });
}

function headerValue(response, name) {
  return (response.headers.get(name.toLowerCase()) || [])[0] || "";
}

function assertNoPrivateBytes(response, label) {
  if (response.body.length > 2048) {
    throw new Error(`${label} body is ${response.body.length} bytes, status ${response.status}`);
  }
  for (const [id, needle] of MARKERS) {
    if (response.body.includes(Buffer.from(needle))) {
      throw new Error(`${label} leaked ${id}, status ${response.status}, ${response.body.length} bytes`);
    }
  }
  for (const [name, prefix] of privatePrefixes) {
    if (prefix.length && response.body.includes(prefix)) {
      throw new Error(`${label} leaked prefix of ${name}, status ${response.status}, ${response.body.length} bytes`);
    }
  }
}

async function assertHidden(method, rawPath) {
  const response = await request(method, rawPath);
  if (![400, 403, 404].includes(response.status)) {
    throw new Error(`${method} ${rawPath} status ${response.status}, ${response.body.length} bytes`);
  }
  assertNoPrivateBytes(response, `${method} ${rawPath}`);
  const type = headerValue(response, "content-type").toLowerCase();
  if (type.includes("sqlite") || type.includes("javascript") || type.includes("json")) {
    throw new Error(`${method} ${rawPath} content-type ${type}`);
  }
}

describe("public static exposure", { concurrency: 1 }, () => {
  before(async () => {
    writeNew(path.join(repoRoot, "data", "app.db"), "SQLite format 3\0SENTINEL_DB_BYTES\n");
    writeNew(path.join(repoRoot, "data", "app.db-wal"), "SENTINEL_WAL_BYTES\n");
    writeNew(path.join(repoRoot, "data", "app.db-shm"), "SENTINEL_SHM_BYTES\n");
    writeNew(path.join(repoRoot, "data", "passwords.txt"), "SENTINEL_PASSWORD_FILE\n");
    writeNew(path.join(repoRoot, ".env"), "ADMIN_PASSWORD=SENTINEL_ENV_SECRET\nSESSION_SECRET=SENTINEL_ENV_SECRET\n");
    writeNew(path.join(repoRoot, "server.js.bak"), "SENTINEL_SOURCE_BACKUP\nconst express = require(\"better-sqlite3\");\n");
    writeNew(path.join(uploadDir, "secret.txt"), "SENTINEL_UPLOAD_SECRET\n");
    writeNew(path.join(imageDir, "app.db"), "SQLite format 3\0SENTINEL_DB_BYTES\n");
    writeNew(path.join(imageDir, "page.html"), "<script>SENTINEL_HTML_UPLOAD</script>\n");
    writeNew(path.join(imageDir, "ok.png"), PNG);
    writeNew(path.join(imageDir, UNICODE_IMAGE), PNG);
    linkNew(path.join(repoRoot, "server.js"), path.join(repoRoot, "assets", "escape.png"));
    linkNew(path.join(repoRoot, "server.js"), path.join(imageDir, "link.png"));

    privatePrefixes = [
      ["server.js", fs.readFileSync(path.join(repoRoot, "server.js")).subarray(0, 48)],
      ["package.json", fs.readFileSync(path.join(repoRoot, "package.json")).subarray(0, 48)],
      [".env.example", fs.readFileSync(path.join(repoRoot, ".env.example")).subarray(0, 48)],
      ["data/app.db", fs.readFileSync(path.join(repoRoot, "data", "app.db")).subarray(0, 48)],
      [".env", fs.readFileSync(path.join(repoRoot, ".env")).subarray(0, 48)],
    ];

    server = await new Promise((resolve, reject) => {
      const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
      listening.on("error", reject);
    });
    port = server.address().port;
  });

  after(async () => {
    if (server) {
      await new Promise((resolve) => server.close(() => resolve()));
    }
    for (const file of created.reverse()) fs.rmSync(file, { force: true });
    const dataDir = path.join(repoRoot, "data");
    if (fs.existsSync(dataDir) && fs.readdirSync(dataDir).length === 0) fs.rmdirSync(dataDir);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("hides private files, encodings, and traversal from GET and HEAD", async () => {
    const failures = [];
    for (const method of ["GET", "HEAD"]) {
      for (const rawPath of HIDDEN_PATHS) {
        try {
          await assertHidden(method, rawPath);
        } catch (error) {
          failures.push(error.message);
        }
      }
      for (const rawPath of ["/server.js", "/data/app.db", "/.env", "/package.json"]) {
        try {
          await assertHidden(method === "GET" ? "POST" : "PUT", rawPath);
        } catch (error) {
          failures.push(error.message);
        }
      }
    }
    for (const rawPath of ["/server.js", "/data/app.db", "/data/app.db-wal", "/.env", "/package.json"]) {
      try {
        const response = await request("GET", rawPath, { headers: { Range: "bytes=0-15" } });
        if (![400, 403, 404].includes(response.status)) {
          throw new Error(`range ${rawPath} status ${response.status}, ${response.body.length} bytes`);
        }
        assertNoPrivateBytes(response, `range ${rawPath}`);
      } catch (error) {
        failures.push(error.message);
      }
    }
    assert.deepEqual(failures, []);
  });

  it("serves the public pages, styles, script, favicon, and images", async () => {
    const pages = [
      ["/", "/index.html", "text/html", "请扫描现场对应板块的二维码"],
      ["/index.html", "/index.html", "text/html", "请扫描现场对应板块的二维码"],
      ["/?s=abc123", "/index.html", "text/html", "请扫描现场对应板块的二维码"],
      ["/login.html", "/login.html", "text/html", "请输入后台账号密码"],
      ["/login.html?error=config", "/login.html", "text/html", "请输入后台账号密码"],
      ["/styles.css", "/styles.css", "text/css", "space-bg.jpg"],
      ["/styles.css?v=1", "/styles.css", "text/css", "space-bg.jpg"],
      ["/styles%2ecss", "/styles.css", "text/css", "space-bg.jpg"],
      ["/script.js", "/script.js", "javascript", "Missing required UI elements"],
      ["/%73cript.js", "/script.js", "javascript", "Missing required UI elements"],
    ];

    for (const [rawPath, file, type, text] of pages) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(method, rawPath);
        assert.equal(response.status, 200, `${method} ${rawPath}`);
        assert.match(headerValue(response, "content-type"), new RegExp(type));
        assert.match(headerValue(response, "cache-control"), /max-age=0/);
        assert.match(headerValue(response, "x-content-type-options"), /nosniff/);
        const disk = fs.readFileSync(path.join(repoRoot, file));
        assert.equal(Number(headerValue(response, "content-length")), disk.length, `${method} ${rawPath}`);
        if (method === "GET") {
          assert.equal(response.body.equals(disk), true, rawPath);
          assert.equal(response.body.includes(Buffer.from(text)), true, rawPath);
        } else {
          assert.equal(response.body.length, 0, `${method} ${rawPath}`);
        }
      }
    }

    for (const method of ["GET", "HEAD"]) {
      const favicon = await request(method, "/favicon.ico");
      assert.equal(favicon.status, 204, method);
      assert.equal(favicon.body.length, 0);
    }

    const assets = [
      ["/assets/logo-white.png", path.join(repoRoot, "assets", "logo-white.png")],
      ["/assets/space-bg.jpg", path.join(repoRoot, "assets", "space-bg.jpg")],
      ["/assets/coming-soon-transparent.gif", path.join(repoRoot, "assets", "coming-soon-transparent.gif")],
      ["/assets/./logo-white.png", path.join(repoRoot, "assets", "logo-white.png")],
      ["/uploads/images/ok.png", path.join(imageDir, "ok.png")],
      [`/uploads/images/${encodeURI(UNICODE_IMAGE)}`, path.join(imageDir, UNICODE_IMAGE)],
    ];
    for (const [rawPath, file] of assets) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(method, rawPath);
        const disk = fs.readFileSync(file);
        assert.equal(response.status, 200, `${method} ${rawPath}`);
        assert.match(headerValue(response, "content-type"), /^image\//);
        assert.match(headerValue(response, "x-content-type-options"), /nosniff/);
        assert.equal(Number(headerValue(response, "content-length")), disk.length);
        if (method === "GET") assert.equal(response.body.equals(disk), true, rawPath);
        else assert.equal(response.body.length, 0);
      }
    }

    const logo = await request("GET", "/assets/logo-white.png");
    assert.match(headerValue(logo, "cache-control"), /max-age=2592000/);
    assert.match(headerValue(logo, "cache-control"), /immutable/);

    for (const rawPath of ["/assets", "/assets/", "/uploads", "/uploads/", "/uploads/images", "/uploads/images/"]) {
      for (const method of ["GET", "HEAD"]) {
        const response = await request(method, rawPath);
        assert.equal(response.status, 404, `${method} ${rawPath}`);
        assert.equal(response.body.includes(Buffer.from("logo-white.png")), false);
        assert.equal(response.body.includes(Buffer.from("ok.png")), false);
      }
    }
  });

  it("keeps public and admin API behavior", async () => {
    const session = await request("GET", "/api/auth/session");
    assert.equal(session.status, 200);
    assert.match(headerValue(session, "content-type"), /json/);
    assert.match(headerValue(session, "cache-control"), /no-store/);
    assert.match(headerValue(session, "x-content-type-options"), /nosniff/);
    assert.deepEqual(JSON.parse(session.body.toString("utf8")), { ok: true, authenticated: false });

    const sessionHead = await request("HEAD", "/api/auth/session");
    assert.equal(sessionHead.status, 200);
    assert.equal(sessionHead.body.length, 0);

    const sections = await request("GET", "/api/sections");
    assert.equal(sections.status, 200);
    assert.equal(JSON.parse(sections.body.toString("utf8")).message, "请扫描对应板块的二维码");
    const sectionsHead = await request("HEAD", "/api/sections");
    assert.equal(sectionsHead.status, 200);

    const next = await request("GET", "/api/next");
    assert.equal(next.status, 200);
    assert.equal(JSON.parse(next.body.toString("utf8")).ok, false);
    const nextHead = await request("HEAD", "/api/next");
    assert.equal(nextHead.status, 200);

    const claim = await request("POST", "/api/claim", {
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(claim.status, 400);
    assert.match(JSON.parse(claim.body.toString("utf8")).message, /领取/);

    const release = await request("POST", "/api/claim/release", {
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(release.status, 200);
    assert.equal(JSON.parse(release.body.toString("utf8")).ok, true);

    const badPreview = await request("POST", "/api/sections/not-valid/preview", {
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(badPreview.status, 400);
    assert.equal(JSON.parse(badPreview.body.toString("utf8")).message, "这个入口无效");

    const missingPreview = await request("POST", "/api/sections/aaaaaaaa/preview", {
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missingPreview.status, 404);
    assert.equal(JSON.parse(missingPreview.body.toString("utf8")).message, "这个入口无效");

    const admin = await request("GET", "/api/admin/state");
    assert.equal(admin.status, 401);
    assert.equal(JSON.parse(admin.body.toString("utf8")).message, "请先登录后台");
    const adminHead = await request("HEAD", "/api/admin/state");
    assert.equal(adminHead.status, 401);

    const deniedPage = await request("GET", "/admin.html");
    assert.equal(deniedPage.status, 302);
    assert.match(headerValue(deniedPage, "location"), /^\/login\.html/);
    assert.equal(deniedPage.body.includes(Buffer.from("每个板块有自己的文案和二维码")), false);
    const deniedHead = await request("HEAD", "/admin.html");
    assert.equal(deniedHead.status, 302);
    assert.match(headerValue(deniedHead, "location"), /^\/login\.html/);

    const encodedAdmin = await request("GET", "/admin%2ehtml");
    assert.notEqual(encodedAdmin.status, 200);
    assert.equal(encodedAdmin.body.includes(Buffer.from("每个板块有自己的文案和二维码")), false);

    const wrong = await request("POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: process.env.ADMIN_USER, password: "wrong-password" }),
    });
    assert.equal(wrong.status, 401);
    assert.equal(headerValue(wrong, "set-cookie"), "");

    const login = await request("POST", "/api/auth/login", {
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: process.env.ADMIN_USER,
        password: process.env.ADMIN_PASSWORD,
      }),
    });
    assert.equal(login.status, 200);
    assert.equal(JSON.parse(login.body.toString("utf8")).ok, true);
    const cookie = headerValue(login, "set-cookie").split(";")[0];
    assert.match(cookie, /^szstm_admin_session=/);
    assert.equal(cookie.includes(process.env.ADMIN_PASSWORD), false);
    const authHeaders = { Cookie: cookie };

    const authedSession = await request("GET", "/api/auth/session", { headers: authHeaders });
    assert.equal(JSON.parse(authedSession.body.toString("utf8")).authenticated, true);

    const authedAdmin = await request("GET", "/api/admin/state", { headers: authHeaders });
    assert.equal(authedAdmin.status, 200);
    const state = JSON.parse(authedAdmin.body.toString("utf8"));
    assert.equal(Array.isArray(state.sections), true);
    assert.equal(typeof state.counts.sectionTotal, "number");
    assert.equal(authedAdmin.body.includes(Buffer.from(process.env.ADMIN_PASSWORD)), false);

    const createdSection = await request("POST", "/api/admin/sections", {
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ name: "静态回归", sortOrder: 3, enabled: true }),
    });
    assert.equal(createdSection.status, 200);
    const section = JSON.parse(createdSection.body.toString("utf8")).section;
    assert.equal(section.name, "静态回归");
    assert.match(section.id, /^[a-f0-9]+$/);

    const removed = await request("DELETE", `/api/admin/sections/${section.id}`, { headers: authHeaders });
    assert.equal(removed.status, 200);
    assert.equal(JSON.parse(removed.body.toString("utf8")).ok, true);

    const page = await request("GET", "/admin.html", { headers: authHeaders });
    assert.equal(page.status, 200);
    assert.match(headerValue(page, "content-type"), /html/);
    assert.match(headerValue(page, "cache-control"), /no-store/);
    assert.equal(page.body.includes(Buffer.from("每个板块有自己的文案和二维码")), true);
    const pageHead = await request("HEAD", "/admin.html", { headers: authHeaders });
    assert.equal(pageHead.status, 200);
    assert.equal(pageHead.body.length, 0);
    assert.equal(Number(headerValue(pageHead, "content-length")), page.body.length);
  });
});

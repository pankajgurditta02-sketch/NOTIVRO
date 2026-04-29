const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const UPLOAD_DIR = path.join(ROOT, "uploads");
const ASSET_DIR = path.join(ROOT, "assets");
const DB_FILE = path.join(DATA_DIR, "resources.json");
const USERS_FILE = path.join(DATA_DIR, "users.json");
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".pdf", ".doc", ".docx", ".ppt", ".pptx", ".txt", ".zip", ".png", ".jpg", ".jpeg"]);

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, "[]\n");
if (!fs.existsSync(USERS_FILE)) {
  const adminUser = {
    id: crypto.randomUUID(),
    email: "admin@pankaj.com",
    password: crypto.createHash("sha256").update("pankajcloud").digest("hex"),
    name: "Administrator",
    createdAt: new Date().toISOString()
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify([adminUser], null, 2));
}

process.on("uncaughtException", (err) => console.error("[CRITICAL] Uncaught Exception:", err));
process.on("unhandledRejection", (reason) => console.error("[CRITICAL] Unhandled Rejection:", reason));

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, message) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(message);
}

function readResources() {
  try {
    return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writeResources(resources) {
  fs.writeFileSync(DB_FILE, `${JSON.stringify(resources, null, 2)}\n`);
}

function readUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, "utf8")); }
  catch { return []; }
}

function writeUsers(users) {
  fs.writeFileSync(USERS_FILE, `${JSON.stringify(users, null, 2)}\n`);
}

function hashPassword(password) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

function sanitizeText(value, fallback = "") {
  return String(value || fallback).replace(/\s+/g, " ").trim().slice(0, 500);
}

function sanitizeFileName(value) {
  const parsed = path.parse(value || "resource.txt");
  const base = parsed.name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 70) || "resource";
  const ext = parsed.ext.toLowerCase();
  return `${base}${ext}`;
}

function collectRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > MAX_UPLOAD_BYTES) {
        console.error(`[Server] Rejected: File too large (${total} bytes)`);
        reject(new Error("File too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      console.log(`[Server] Successfully collected ${total} bytes.`);
      resolve(Buffer.concat(chunks));
    });
    req.on("error", (err) => {
      console.error("[Server] Data Stream Error:", err);
      reject(err);
    });
  });
}

function parseContentDisposition(header = "") {
  const result = {};
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (!rawKey || rawValue.length === 0) continue;
    result[rawKey.toLowerCase()] = rawValue.join("=").trim().replace(/^"|"$/g, "");
  }
  return result;
}

function parseMultipart(buffer, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const fields = {};
  let file = null;
  let cursor = 0;

  while (cursor < buffer.length) {
    const boundaryStart = buffer.indexOf(boundaryBuffer, cursor);
    if (boundaryStart === -1) break;

    const partStart = boundaryStart + boundaryBuffer.length;
    if (buffer.slice(partStart, partStart + 2).toString() === "--") break;

    const headerStart = partStart + 2;
    const headerEnd = buffer.indexOf(Buffer.from("\r\n\r\n"), headerStart);
    if (headerEnd === -1) break;

    const headersText = buffer.slice(headerStart, headerEnd).toString("utf8");
    const headers = Object.fromEntries(headersText.split(/\r?\n/).map((line) => {
      const separator = line.indexOf(":");
      if (separator === -1) return ["", ""];
      return [line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()];
    }).filter(([key]) => key));

    const nextBoundary = buffer.indexOf(boundaryBuffer, headerEnd + 4);
    if (nextBoundary === -1) break;

    let content = buffer.slice(headerEnd + 4, nextBoundary);
    if (content.slice(-2).toString() === "\r\n") content = content.slice(0, -2);

    const disposition = parseContentDisposition(headers["content-disposition"]);
    if (disposition.filename) {
      file = {
        fieldName: disposition.name,
        originalName: disposition.filename,
        contentType: headers["content-type"] || "application/octet-stream",
        buffer: content
      };
    } else if (disposition.name) {
      fields[disposition.name] = content.toString("utf8").trim();
    }

    cursor = nextBoundary;
  }

  return { fields, file };
}

function serveFile(res, filePath, downloadName = "") {
  const resolved = path.resolve(filePath);
  const allowedRoots = [path.resolve(ROOT), path.resolve(UPLOAD_DIR)];
  if (!allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`))) {
    sendText(res, 403, "Forbidden");
    return;
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    sendText(res, 404, "Not found");
    return;
  }
  const ext = path.extname(resolved).toLowerCase();
  const headers = { "content-type": mimeTypes[ext] || "application/octet-stream" };
  if (downloadName) headers["content-disposition"] = `attachment; filename="${downloadName.replace(/"/g, "")}"`;
  res.writeHead(200, headers);
  fs.createReadStream(resolved).pipe(res);
}

async function handleCreateResource(req, res) {
  const contentType = req.headers["content-type"] || "";
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!boundaryMatch) {
    sendJson(res, 400, { error: "Expected multipart/form-data upload." });
    return;
  }

  try {
    console.log("[Server] Upload started...");
    const body = await collectRequestBody(req);
    console.log(`[Server] Received body of ${body.length} bytes`);
    const { fields, file } = parseMultipart(body, boundaryMatch[1] || boundaryMatch[2]);
    if (!file || file.buffer.length === 0) {
      sendJson(res, 400, { error: "Please attach a notes file." });
      return;
    }

    const safeOriginal = sanitizeFileName(file.originalName);
    const ext = path.extname(safeOriginal).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(ext)) {
      sendJson(res, 400, { error: "Unsupported file type. Use PDF, DOC, PPT, TXT, ZIP, PNG, or JPG." });
      return;
    }

    const id = crypto.randomUUID();
    const fileName = `${Date.now()}-${id.slice(0, 8)}-${safeOriginal}`;
    const target = path.join(UPLOAD_DIR, fileName);
    fs.writeFileSync(target, file.buffer);

    const resource = {
      id,
      title: sanitizeText(fields.title, "Untitled Resource").slice(0, 120),
      subject: sanitizeText(fields.subject, "General").slice(0, 80),
      type: ["Notes", "PYQ", "Manual"].includes(fields.type) ? fields.type : "Notes",
      year: ["1st Year", "2nd Year", "3rd Year", "4th Year"].includes(fields.year) ? fields.year : "2nd Year",
      branch: sanitizeText(fields.branch, "CSE").slice(0, 80),
      author: sanitizeText(fields.author, "Anonymous").slice(0, 80),
      description: sanitizeText(fields.description, "Student uploaded academic resource.").slice(0, 380),
      views: 0,
      downloads: 0,
      rating: 5,
      fileName,
      originalName: safeOriginal,
      fileUrl: `/uploads/${encodeURIComponent(fileName)}`,
      createdAt: new Date().toISOString()
    };

    const resources = readResources();
    resources.unshift(resource);
    writeResources(resources);
    sendJson(res, 201, resource);
  } catch (error) {
    sendJson(res, 400, { error: error.message || "Upload failed." });
  }
}

function handleDownload(id, res) {
  const resources = readResources();
  const resource = resources.find((item) => item.id === id);
  if (!resource) {
    sendText(res, 404, "Resource not found");
    return;
  }
  resource.downloads = Number(resource.downloads || 0) + 1;
  writeResources(resources);
  serveFile(res, path.join(UPLOAD_DIR, resource.fileName), resource.originalName || resource.fileName);
}

async function handleSignup(req, res) {
  try {
    const raw = await collectRequestBody(req);
    console.log("[Server] Raw Signup Body:", raw.toString());
    const { email, password, name } = JSON.parse(raw.toString());
    if (!email || !password || !name) throw new Error("Missing fields");
    
    const users = readUsers();
    if (users.find(u => u.email === email)) throw new Error("Email already exists");
    
    const user = { id: crypto.randomUUID(), email, password: hashPassword(password), name, createdAt: new Date().toISOString() };
    users.push(user);
    writeUsers(users);
    
    console.log("[Server] User created successfully:", email);
    sendJson(res, 201, { id: user.id, email: user.email, name: user.name });
  } catch (err) {
    console.error("[Server] Signup Error:", err.message);
    sendJson(res, 400, { error: err.message });
  }
}

async function handleLogin(req, res) {
  try {
    const raw = await collectRequestBody(req);
    console.log("[Server] Raw Login Body:", raw.toString());
    const { email, password } = JSON.parse(raw.toString());
    
    let users = readUsers();
    
    // Auto-seed if database is missing or empty
    if (users.length === 0) {
      console.log("[Server] Database empty. Auto-seeding master account...");
      const adminUser = {
        id: crypto.randomUUID(),
        email: "admin@pankaj.com",
        password: crypto.createHash("sha256").update("pankajcloud").digest("hex"),
        name: "Administrator",
        createdAt: new Date().toISOString()
      };
      users = [adminUser];
      writeUsers(users);
    }
    
    const user = users.find(u => u.email === email && u.password === hashPassword(password));
    
    if (!user) {
      console.warn("[Server] Login failed for:", email);
      throw new Error("Invalid credentials");
    }
    
    console.log("[Server] Login successful for:", email);
    sendJson(res, 200, { token: `mock-token-${user.id}`, user: { id: user.id, email: user.email, name: user.name } });
  } catch (err) {
    console.error("[Server] Login Error:", err.message);
    sendJson(res, 401, { error: err.message });
  }
}

function handleRequest(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  console.log(`[API] ${req.method} ${url.pathname}`);

  if (req.method === "GET" && url.pathname === "/api/health") {
    sendJson(res, 200, { ok: true, uptime: process.uptime() });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/signup") {
    handleSignup(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/auth/login") {
    handleLogin(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/resources") {
    sendJson(res, 200, readResources());
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/resources") {
    handleCreateResource(req, res);
    return;
  }

  const downloadMatch = url.pathname.match(/^\/api\/resources\/([^/]+)\/download$/);
  if (req.method === "GET" && downloadMatch) {
    handleDownload(decodeURIComponent(downloadMatch[1]), res);
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/uploads/")) {
    const fileName = decodeURIComponent(url.pathname.replace("/uploads/", ""));
    serveFile(res, path.join(UPLOAD_DIR, fileName));
    return;
  }

  if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
    const fileName = decodeURIComponent(url.pathname.replace("/assets/", ""));
    serveFile(res, path.join(ASSET_DIR, fileName));
    return;
  }

  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    serveFile(res, path.join(ROOT, "index.html"));
    return;
  }

  sendText(res, 404, "Not found");
}

const server = http.createServer((req, res) => {
  handleRequest(req, res);
});

server.keepAliveTimeout = 120000;
server.headersTimeout = 125000;

server.listen(PORT, () => {
  console.log(`
  🚀 Notivro Server Live
  📡 Endpoint: http://localhost:${PORT}
  🛠️  Mode: Public (Auth Disabled)
  `);
});

// Local test server: serves the site and runs apps-script/Code.gs against in-memory
// stand-ins for Google's services (Sheets, Drive, cache, properties). Nothing is saved.
//
//   node dev/mock-server.js        -> http://localhost:8767   (admin passcode: test-pass)
const http = require("http");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const crypto = require("crypto");

const ROOT = path.resolve(__dirname, "..");
const PORT = Number(process.env.PORT || 8767);
const PASS = process.env.ADMIN_PASSCODE || "test-pass";

// ---------------------------------------------------------------- fake Google services
const props = new Map();
const cacheStore = new Map();
const sheets = new Map();
const driveFiles = new Map();   // id -> { name, mime, bytes(Buffer), trashed, folder }
let nextId = 1;
const newId = p => p + (nextId++).toString(36).padStart(6, "0") + crypto.randomBytes(6).toString("hex");

const signed = buf => [...buf].map(b => b > 127 ? b - 256 : b);
const toBuf = v => Buffer.isBuffer(v) ? v : Array.isArray(v) ? Buffer.from(v.map(b => b & 255)) : Buffer.from(String(v), "utf8");
const strip = v => (typeof v === "string" && v.startsWith("'")) ? v.slice(1) : v;

function makeSheet(name) {
  const rows = [];
  const range = (r, c, nr = 1, nc = 1) => ({
    getValues: () => rows.slice(r - 1, r - 1 + nr).map(row => {
      const out = [];
      for (let i = 0; i < nc; i++) out.push(row[c - 1 + i] === undefined ? "" : row[c - 1 + i]);
      return out;
    }),
    setValue: v => { while (rows.length < r) rows.push([]); rows[r - 1][c - 1] = strip(v); },
    setValues: vals => vals.forEach((vr, i) => vr.forEach((v, j) => {
      while (rows.length < r + i) rows.push([]);
      rows[r - 1 + i][c - 1 + j] = strip(v);
    })),
  });
  return {
    _rows: rows,
    getName: () => name,
    appendRow: r => rows.push(r.map(strip)),
    getLastRow: () => rows.length,
    setFrozenRows: () => {},
    getRange: range,
  };
}
const spreadsheet = {
  getId: () => "mock-sheet-id",
  getName: () => "Mock sheet",
  getSheetByName: n => sheets.get(n) || null,
  insertSheet: n => { const s = makeSheet(n); sheets.set(n, s); return s; },
};

function makeBlob(bytes, mime, name) {
  const buf = toBuf(bytes);
  return { _buf: buf, getBytes: () => signed(buf), getContentType: () => mime, getName: () => name, getDataAsString: () => buf.toString("utf8") };
}
function makeFile(id) {
  const f = driveFiles.get(id);
  return {
    getId: () => id,
    getName: () => f.name,
    getBlob: () => makeBlob(f.bytes, f.mime, f.name),
    setTrashed: t => { f.trashed = !!t; },
  };
}
const folders = new Map();
function makeFolder(id) {
  return {
    getId: () => id,
    getName: () => folders.get(id).name,
    createFolder: name => { const fid = newId("fold"); folders.set(fid, { name, parent: id }); return makeFolder(fid); },
    createFile: blob => {
      const fid = newId("file");
      driveFiles.set(fid, { name: blob.getName(), mime: blob.getContentType(), bytes: blob._buf, trashed: false, folder: id });
      return makeFile(fid);
    },
  };
}

const sandbox = {
  console, JSON, Date, Math, Map, Array, Object, String, Number, Error, RegExp,
  SpreadsheetApp: {
    getActiveSpreadsheet: () => spreadsheet,
    openById: id => { if (id !== "mock-sheet-id") throw new Error("bad id"); return spreadsheet; },
    flush: () => {},
  },
  DriveApp: {
    createFolder: name => { const id = newId("fold"); folders.set(id, { name, parent: null }); return makeFolder(id); },
    getFolderById: id => { if (!folders.has(id)) throw new Error("no folder"); return makeFolder(id); },
    getFileById: id => { if (!driveFiles.has(id)) throw new Error("no file"); return makeFile(id); },
  },
  PropertiesService: { getScriptProperties: () => ({
    getProperty: k => props.has(k) ? props.get(k) : null,
    setProperty: (k, v) => props.set(k, String(v)),
  }) },
  CacheService: { getScriptCache: () => ({
    get: k => { const e = cacheStore.get(k); if (!e || e.exp < Date.now()) return null; return e.v; },
    put: (k, v, ttl) => {
      if (String(v).length > 100 * 1024) throw new Error("Argument too large");
      cacheStore.set(k, { v: String(v), exp: Date.now() + (ttl || 600) * 1000 });
    },
    remove: k => cacheStore.delete(k),
  }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  Utilities: {
    DigestAlgorithm: { SHA_256: "sha256" },
    Charset: { UTF_8: "utf8" },
    getUuid: () => crypto.randomUUID(),
    base64Decode: s => {
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new Error("Could not decode string.");
      return signed(Buffer.from(s, "base64"));
    },
    base64Encode: v => toBuf(v).toString("base64"),
    computeDigest: (alg, value) => signed(crypto.createHash(alg).update(toBuf(value)).digest()),
    newBlob: (bytes, mime, name) => makeBlob(bytes, mime, name),
    formatDate: d => d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, ""),
  },
  ContentService: {
    MimeType: { JSON: "application/json" },
    createTextOutput: s => ({ content: s, setMimeType() { return this; } }),
  },
};

const code = fs.readFileSync(path.join(ROOT, "apps-script", "Code.gs"), "utf8");
vm.createContext(sandbox);
vm.runInContext(code, sandbox, { filename: "Code.gs" });
vm.runInContext("setup()", sandbox);
props.set("ADMIN_PASSCODE", PASS);

// ---------------------------------------------------------------- HTTP
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg" };

http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname === "/exec") {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      const parameter = Object.fromEntries(url.searchParams);
      const body = Buffer.concat(chunks).toString("utf8");
      const out = req.method === "POST"
        ? sandbox.doPost({ parameter, postData: { contents: body } })
        : sandbox.doGet({ parameter });
      res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
      res.end(out.content);
    });
    return;
  }
  if (url.pathname === "/__state") { // test helper: what's in the sheet and Drive
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      proofs: (sheets.get("Proofs") || { _rows: [] })._rows,
      rounds: (sheets.get("Rounds") || { _rows: [] })._rows,
      files: [...driveFiles].map(([id, f]) => ({ id, name: f.name, size: f.bytes.length, trashed: f.trashed })),
      props: Object.fromEntries([...props].filter(([k]) => k !== "ADMIN_PASSCODE")),
    }));
  }
  if (url.pathname === "/__clearcache") { cacheStore.clear(); res.writeHead(200); return res.end("cleared"); }
  if (url.pathname === "/config.js") { // point the site at this mock
    res.writeHead(200, { "Content-Type": "text/javascript" });
    return res.end(`window.TRACKER_CONFIG = {
      ENDPOINT_URL: "http://localhost:${PORT}/exec",
      TITLE: "Like, comment, send your proof (LOCAL TEST)",
      SUBTITLE: "Mock backend. Nothing here is saved.",
      STATS_REFRESH_SECONDS: 10,
    };`);
  }
  const file = path.normalize(path.join(ROOT, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end("not found"); }
    res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log("Mock server on http://localhost:" + PORT + "  (admin passcode: " + PASS + ")"));

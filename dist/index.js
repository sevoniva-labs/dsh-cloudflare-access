// src/index.ts
import z from "@deepseek-ai/schemastery";
import "@deepseek-ai/dsh-host-webserver";
import "@deepseek-ai/dsh-client-connection";
import { credentialRef } from "@deepseek-ai/dsh-credentials";
import { homedir as homedir2 } from "node:os";
import { isAbsolute, join as join3 } from "node:path";
import { mkdir as mkdir2 } from "node:fs/promises";
import lockfile from "proper-lockfile";

// src/controller.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// src/model.ts
var PREFIX = "/__dsh_cloudflare_access";
var UserError = class extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
  code;
  status;
};
function fail(code, message, status = 400) {
  throw new UserError(code, message, status);
}
function publicError(error) {
  return error instanceof UserError ? { code: error.code, message: error.message } : { code: "INTERNAL", message: "\u64CD\u4F5C\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u672C\u673A\u670D\u52A1\u72B6\u6001\u540E\u91CD\u8BD5\u3002\u5185\u90E8\u5F02\u5E38\u548C\u51ED\u636E\u4E0D\u4F1A\u8FD4\u56DE\u6D4F\u89C8\u5668\u3002" };
}
function validateSetup(input) {
  if (!input || typeof input !== "object") fail("INPUT", "\u914D\u7F6E\u683C\u5F0F\u9519\u8BEF\u3002");
  const p = input;
  for (const key of ["accountId", "zoneId"]) if (typeof p[key] !== "string" || !/^[a-f0-9]{32}$/i.test(p[key])) fail("INPUT", "\u8BF7\u9009\u62E9\u6709\u6548\u7684 Cloudflare \u8D26\u53F7\u548C\u57DF\u540D\u3002");
  if (typeof p.hostname !== "string") fail("HOSTNAME", "\u8BF7\u586B\u5199\u5B50\u57DF\u540D\u3002");
  const hostname = p.hostname.trim().toLowerCase();
  if (hostname.length > 253 || !hostname.includes(".") || !hostname.split(".").every((x) => /^(?!-)[a-z0-9-]{1,63}(?<!-)$/.test(x))) fail("HOSTNAME", "\u8BF7\u586B\u5199\u5B8C\u6574\u5B50\u57DF\u540D\uFF0C\u4E0D\u8981\u5305\u542B\u534F\u8BAE\u3001\u8DEF\u5F84\u3001\u7AEF\u53E3\u6216\u901A\u914D\u7B26\u3002");
  if (!Array.isArray(p.emails) || p.emails.length < 1 || p.emails.length > 50 || !p.emails.every((x) => typeof x === "string" && /^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(x))) fail("EMAILS", "\u81F3\u5C11\u586B\u5199\u4E00\u4E2A\u660E\u786E\u7684\u5141\u8BB8\u90AE\u7BB1\uFF0C\u4E0D\u63A5\u53D7\u901A\u914D\u7B26\u3002");
  const emails = [...new Set(p.emails.map((x) => x.toLowerCase()))].sort();
  if (typeof p.identityProvider !== "string" || !/^(otp|[a-zA-Z0-9-]{1,80})$/.test(p.identityProvider)) fail("IDP", "\u8BF7\u9009\u62E9\u767B\u5F55\u65B9\u5F0F\u3002");
  const postureChecks = p.postureChecks ?? [];
  if (!Array.isArray(postureChecks) || postureChecks.length > 10 || !postureChecks.every((x) => typeof x === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(x))) fail("POSTURE", "\u8BBE\u5907\u68C0\u67E5 ID \u683C\u5F0F\u4E0D\u6B63\u786E\u3002");
  return { accountId: p.accountId, zoneId: p.zoneId, hostname, emails, identityProvider: p.identityProvider, postureChecks: [...new Set(postureChecks)].sort() };
}
function sameSetup(a, b) {
  return JSON.stringify(validateSetup(a)) === JSON.stringify(validateSetup(b));
}
function authDomain(value) {
  if (typeof value !== "string") fail("ORGANIZATION", "\u8BF7\u5148\u5728 Cloudflare \u5B8C\u6210 Zero Trust \u521D\u59CB\u5316\u3002");
  const domain = value.replace(/^https:\/\//, "").replace(/\/$/, "").toLowerCase();
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(domain)) fail("ORGANIZATION", "Cloudflare \u8FD4\u56DE\u4E86\u4E0D\u652F\u6301\u7684\u8BA4\u8BC1\u57DF\u540D\u3002");
  return domain;
}

// src/cloudflare.ts
var Cloudflare = class {
  constructor(token, fetcher = fetch) {
    this.token = token;
    this.fetcher = fetcher;
    if (typeof token !== "string" || token.length < 10 || token.length > 4096 || /\s/.test(token)) fail("TOKEN", "\u8BF7\u586B\u5199 Cloudflare API Token\uFF08\u4E0D\u662F Global API Key\uFF09\u3002");
  }
  token;
  fetcher;
  async envelope(method, path, body2) {
    let response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method,
        headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
        body: body2 === void 0 ? void 0 : JSON.stringify(body2),
        signal: AbortSignal.timeout(2e4),
        redirect: "error"
      });
    } catch {
      throw new UserError("CF_NETWORK", "Cloudflare \u8BF7\u6C42\u672A\u5B8C\u6210\u3002\u5199\u5165\u7ED3\u679C\u53EF\u80FD\u4E0D\u786E\u5B9A\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u540E\u6062\u590D\uFF0C\u4E0D\u8981\u91CD\u590D\u521B\u5EFA\u3002", 502);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new UserError("CF_RESPONSE", "Cloudflare \u8FD4\u56DE\u4E86\u65E0\u6CD5\u89E3\u6790\u7684\u54CD\u5E94\u3002", 502);
    }
    if (!response.ok || data.success !== true) {
      const code = data.errors?.[0]?.code;
      throw new UserError("CF_API", `Cloudflare ${method} ${path.split("?")[0]} \u5931\u8D25\uFF08HTTP ${response.status}${typeof code === "number" ? `\uFF0C\u4EE3\u7801 ${code}` : ""}\uFF09\u3002\u8BF7\u68C0\u67E5 Token \u8303\u56F4\u548C\u6743\u9650\u3002`, 502);
    }
    return data;
  }
  async request(method, path, body2) {
    return (await this.envelope(method, path, body2)).result;
  }
  async list(path) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const data = await this.envelope("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=50&page=${page}`);
      if (!Array.isArray(data.result)) fail("CF_RESPONSE", "Cloudflare \u5217\u8868\u54CD\u5E94\u683C\u5F0F\u5F02\u5E38\u3002");
      rows.push(...data.result);
      if (data.result_info?.total_pages !== void 0 ? page >= data.result_info.total_pages : data.result.length < 50) return rows;
    }
    fail("CF_PAGINATION", "Cloudflare \u5217\u8868\u8FC7\u5927\uFF0C\u65E0\u6CD5\u5B89\u5168\u786E\u8BA4\u8D44\u6E90\u51B2\u7A81\uFF1B\u5DF2\u505C\u6B62\u3002");
  }
};
function applicationMatches(app, hostname) {
  const destinations = Array.isArray(app.destinations) ? app.destinations : [];
  const domains = [app.domain, ...destinations.map((x) => x.uri ?? x.hostname)].filter((x) => typeof x === "string");
  return domains.some((value) => {
    const host = value.replace(/^https?:\/\//, "").split("/")[0].toLowerCase();
    const pattern = host.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    return new RegExp(`^${pattern}$`).test(hostname);
  });
}

// src/cloudflared.ts
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdtemp, readFile as readFile2, rm, unlink as unlink2 } from "node:fs/promises";
import { constants } from "node:fs";
import { join as join2 } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createHash } from "node:crypto";

// src/store.ts
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
var StateStore = class {
  constructor(directory) {
    this.directory = directory;
  }
  directory;
  state = { version: 1, installationId: randomUUID(), enabled: false, phase: "unconfigured" };
  async load() {
    try {
      const value = JSON.parse(await readFile(join(this.directory, "state.json"), "utf8"));
      if (value.version !== 1 || typeof value.installationId !== "string" || !/^[a-f0-9-]{36}$/.test(value.installationId) || typeof value.enabled !== "boolean") throw new Error("invalid");
      if (!["unconfigured", "provisioning", "configured", "error"].includes(value.phase)) throw new Error("phase");
      if (value.deployment) {
        validateSetup(value.deployment);
        authDomain(value.deployment.authDomain);
        if (!Number.isInteger(value.deployment.gatewayPort) || value.deployment.gatewayPort < 1024 || value.deployment.gatewayPort > 65535) throw new Error("port");
        for (const id of ["appId", "policyId", "tunnelId", "dnsId"]) if (value.deployment[id] !== void 0 && !/^[a-zA-Z0-9-]{1,100}$/.test(value.deployment[id])) throw new Error("id");
      } else if (value.enabled || value.phase !== "unconfigured") throw new Error("deployment");
      this.state = value;
    } catch (error) {
      if (error.code !== "ENOENT") fail("STATE_INVALID", "\u672C\u673A\u72B6\u6001\u6587\u4EF6\u635F\u574F\uFF1B\u5DF2\u505C\u6B62\u8FDC\u7A0B\u53D1\u5E03\uFF0C\u8BF7\u5148\u6062\u590D\u5907\u4EFD\u3002");
    }
  }
  async save() {
    await privateWrite(join(this.directory, "state.json"), JSON.stringify(this.state, null, 2) + "\n");
  }
};
async function privateWrite(path, content) {
  await mkdir(dirname(path), { recursive: true, mode: 448 });
  const temp = `${path}.${randomUUID()}.tmp`;
  const file = await open(temp, "wx", 384);
  try {
    await file.writeFile(content);
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => {
    });
    throw error;
  }
}

// src/cloudflared.ts
var run = promisify(execFile);
var CLOUDFLARED_VERSION = "2026.9.1";
var Connector = class {
  constructor(directory, configuredPath, onFailure = () => {
  }) {
    this.directory = directory;
    this.configuredPath = configuredPath;
    this.onFailure = onFailure;
  }
  directory;
  configuredPath;
  onFailure;
  child;
  stopping = false;
  status = "stopped";
  async executable() {
    const candidates = this.configuredPath ? [this.configuredPath] : [join2(this.directory, "bin", "cloudflared"), join2(homedir(), ".local/bin/cloudflared"), "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"];
    for (const file of candidates) {
      try {
        await access(file, constants.X_OK);
        const { stdout } = await run(file, ["--version"], { timeout: 5e3, maxBuffer: 4096 });
        if (/cloudflared version \d{4}\.\d+\.\d+/.test(stdout)) return file;
      } catch {
      }
    }
    return void 0;
  }
  async install() {
    if (this.child) fail("RUNNING", "\u8BF7\u5148\u505C\u7528\u5165\u53E3\uFF0C\u518D\u5B89\u88C5\u8FDE\u63A5\u5668\u3002");
    const platform = process.platform, arch = process.arch;
    if (!["darwin", "linux"].includes(platform) || !["arm64", "x64"].includes(arch)) fail("PLATFORM", "\u81EA\u52A8\u5B89\u88C5\u6682\u652F\u6301 macOS/Linux \u7684 arm64 \u548C x64\uFF1B\u8BF7\u624B\u52A8\u6307\u5B9A\u5B98\u65B9 cloudflared \u8DEF\u5F84\u3002");
    const assetName = `cloudflared-${platform}-${arch === "x64" ? "amd64" : arch}${platform === "darwin" ? ".tgz" : ""}`;
    const response = await fetch(`https://api.github.com/repos/cloudflare/cloudflared/releases/tags/${CLOUDFLARED_VERSION}`, { signal: AbortSignal.timeout(2e4) });
    if (!response.ok) fail("DOWNLOAD", "\u65E0\u6CD5\u8BFB\u53D6\u5B98\u65B9\u53D1\u5E03\u4FE1\u606F\uFF0C\u8BF7\u901A\u8FC7\u7CFB\u7EDF\u4EE3\u7406\u91CD\u8BD5\u6216\u624B\u52A8\u5B89\u88C5 cloudflared\u3002");
    const release = await response.json();
    const asset = release.assets.find((x) => x.name === assetName);
    if (release.tag_name !== CLOUDFLARED_VERSION || !asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest ?? "") || asset.browser_download_url !== `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${assetName}`) fail("CHECKSUM", "\u5B98\u65B9\u53D1\u5E03\u7F3A\u5C11\u53EF\u9A8C\u8BC1\u7684 SHA-256\uFF0C\u5DF2\u505C\u6B62\u5B89\u88C5\u3002");
    const download = await fetch(asset.browser_download_url, { signal: AbortSignal.timeout(12e4) });
    if (!download.ok || !download.body) fail("DOWNLOAD", "\u5B98\u65B9\u8FDE\u63A5\u5668\u4E0B\u8F7D\u5931\u8D25\u3002");
    const chunks = [];
    let size = 0;
    for await (const chunk of download.body) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) fail("DOWNLOAD", "\u4E0B\u8F7D\u6587\u4EF6\u8D85\u8FC7\u9884\u671F\u5927\u5C0F\u3002");
      chunks.push(chunk);
    }
    const bytes = Buffer.concat(chunks);
    if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== asset.digest) fail("CHECKSUM", "\u8FDE\u63A5\u5668\u6821\u9A8C\u5931\u8D25\uFF0C\u672A\u5B89\u88C5\u3002");
    const temp = await mkdtemp(join2(tmpdir(), "dsh-cloudflare-access-download-"));
    try {
      let binary = bytes;
      if (platform === "darwin") {
        const archive = join2(temp, "release.tgz");
        await privateWrite(archive, bytes);
        await run("/usr/bin/tar", ["-xzf", archive, "-C", temp, "cloudflared"], { timeout: 15e3 });
        binary = await readFile2(join2(temp, "cloudflared"));
      }
      const target = join2(this.directory, "bin", "cloudflared");
      await privateWrite(target, binary);
      await chmod(target, 448);
      const { stdout } = await run(target, ["--version"], { timeout: 5e3 });
      if (!stdout.includes(`version ${CLOUDFLARED_VERSION}`)) {
        await unlink2(target);
        fail("VERSION", "\u8FDE\u63A5\u5668\u7248\u672C\u9A8C\u8BC1\u5931\u8D25\u3002");
      }
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
  async start(token) {
    if (this.child) return;
    const binary = await this.executable();
    if (!binary) fail("CONNECTOR_MISSING", "\u5C1A\u672A\u5B89\u88C5\u5B98\u65B9 cloudflared\uFF0C\u8BF7\u70B9\u51FB\u5B89\u88C5\u8FDE\u63A5\u5668\u3002");
    const tokenFile = join2(this.directory, "tunnel-token.runtime");
    await privateWrite(tokenFile, token);
    this.stopping = false;
    this.status = "starting";
    const child = spawn(binary, ["tunnel", "--no-autoupdate", "run", "--token-file", tokenFile], { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, TUNNEL_LOGLEVEL: "info" } });
    this.child = child;
    let tail = "";
    child.stderr?.on("data", (data) => {
      tail = (tail + data.toString()).slice(-4096);
      if (tail.includes("Registered tunnel connection")) this.status = "connected";
    });
    child.once("exit", () => {
      this.child = void 0;
      this.status = this.stopping ? "stopped" : "failed";
      void unlink2(tokenFile).catch(() => {
      });
      if (!this.stopping) this.onFailure();
    });
    await new Promise((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", () => {
        this.child = void 0;
        this.status = "failed";
        void unlink2(tokenFile).catch(() => {
        });
        reject(new Error("connector spawn"));
      });
    });
  }
  async stop() {
    this.stopping = true;
    const child = this.child;
    if (child) await new Promise((resolve) => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5e3);
      timer.unref();
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
      child.kill("SIGTERM");
    });
    this.child = void 0;
    this.status = "stopped";
    await unlink2(join2(this.directory, "tunnel-token.runtime")).catch(() => {
    });
  }
};

// src/gateway.ts
import { createServer, request } from "node:http";
import { createHash as createHash2 } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";
function accessVerifier(d, fetcher = fetch) {
  const issuer = `https://${authDomain(d.authDomain)}`;
  if (!d.audience) fail("AUDIENCE", "Access audience \u7F3A\u5931\u3002");
  const keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 5e3, [customFetch]: fetcher });
  return async (token) => {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: d.audience, algorithms: ["RS256"], requiredClaims: ["exp", "sub", "email", "iat"], maxTokenAge: "2h" });
    if (payload.type !== "app" || typeof payload.email !== "string" || !d.emails.includes(payload.email.toLowerCase()) || !payload.sub || !payload.exp) throw new Error("identity");
    return { email: payload.email.toLowerCase(), subject: payload.sub, expires: payload.exp * 1e3, fingerprint: createHash2("sha256").update(token).digest("hex") };
  };
}
function json(res, status, value) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
  res.end(JSON.stringify(value));
}
function loopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
function localAdmin(req, port, authenticated) {
  if (!loopback(req.socket.remoteAddress) || !authenticated) return false;
  if (Object.keys(req.headers).some((x) => x.startsWith("cf-") || x.startsWith("x-forwarded-") || x === "forwarded")) return false;
  const host = req.headers.host;
  if (![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host ?? "")) return false;
  return req.method === "GET" ? !req.headers.origin || req.headers.origin === `http://${host}` : req.headers.origin === `http://${host}`;
}
var NativeSession = class {
  constructor(port, authenticatedUrl) {
    this.port = port;
    this.authenticatedUrl = authenticatedUrl;
  }
  port;
  authenticatedUrl;
  cookie;
  pending;
  reset() {
    this.cookie = void 0;
  }
  async get() {
    if (this.cookie) return this.cookie;
    if (this.pending) return this.pending;
    this.pending = new Promise((resolve, reject) => {
      const target = new URL(this.authenticatedUrl(`http://127.0.0.1:${this.port}`));
      if (target.origin !== `http://127.0.0.1:${this.port}`) {
        reject(new Error("bootstrap origin"));
        return;
      }
      const r = request(target, { method: "GET" }, (res) => {
        res.resume();
        const cookies = res.headers["set-cookie"]?.filter((x) => x.startsWith("dsh-auth-"));
        if (res.statusCode !== 303 || cookies?.length !== 1) {
          reject(new Error("native bootstrap"));
          return;
        }
        this.cookie = cookies[0].split(";")[0];
        resolve(this.cookie);
      });
      r.setTimeout(5e3, () => r.destroy(new Error("bootstrap timeout")));
      r.on("error", () => reject(new Error("native bootstrap")));
      r.end();
    });
    try {
      return await this.pending;
    } finally {
      this.pending = void 0;
    }
  }
};
var hop = /* @__PURE__ */ new Set(["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]);
function clean(headers, websocket = false) {
  const nominated = String(headers.connection ?? "").split(",").map((x) => x.trim().toLowerCase());
  const result = {};
  for (const [key, value] of Object.entries(headers)) {
    if (hop.has(key) || nominated.includes(key) || key === "cookie" || key === "authorization" || key === "set-cookie" || key === "forwarded" || key.startsWith("cf-") || key.startsWith("x-forwarded-")) continue;
    result[key] = value;
  }
  if (websocket) {
    result.connection = "Upgrade";
    result.upgrade = "websocket";
  }
  return result;
}
var Gateway = class {
  constructor(options) {
    this.options = options;
    this.verify = options.verify ?? accessVerifier(options.deployment);
    this.server.on("request", (req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) json(res, 502, { error: "\u8FDC\u7A0B\u5165\u53E3\u6682\u4E0D\u53EF\u7528\uFF0C\u8BF7\u68C0\u67E5\u672C\u673A Harness\u3002" });
        else res.destroy();
      });
    });
    this.server.on("upgrade", (req, socket, head) => {
      void this.upgrade(req, socket, head).catch(() => socket.destroy());
    });
    this.server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    this.server.on("clientError", (_e, socket) => socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"));
    this.server.requestTimeout = 3e5;
  }
  options;
  server = createServer();
  verify;
  sockets = /* @__PURE__ */ new Set();
  active = /* @__PURE__ */ new Map();
  leases = /* @__PURE__ */ new Map();
  revoked = /* @__PURE__ */ new Map();
  timer;
  async start() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.deployment.gatewayPort, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    this.timer = setInterval(() => this.sweep(), 1e3);
    this.timer.unref();
  }
  async stop() {
    clearInterval(this.timer);
    for (const socket of this.active.keys()) socket.destroy();
    for (const socket of this.sockets) socket.destroy();
    this.active.clear();
    this.leases.clear();
    this.revoked.clear();
    if (this.server.listening) await new Promise((resolve) => this.server.close(() => resolve()));
  }
  sweep() {
    const now = Date.now(), lease = this.options.leaseMs ?? 9e4;
    for (const [socket, { identity, since }] of this.active) {
      if (identity.expires <= now || this.revoked.has(identity.fingerprint) || now - (this.leases.get(identity.fingerprint) ?? since) > lease) socket.destroy();
    }
    for (const [fp, exp] of this.revoked) if (exp <= now) this.revoked.delete(fp);
    for (const [fp, time] of this.leases) if (time + lease < now) this.leases.delete(fp);
  }
  track(socket, identity) {
    this.active.set(socket, { identity, since: Date.now() });
    socket.once("close", () => this.active.delete(socket));
  }
  async identity(req, websocket = false) {
    const host = this.options.deployment.hostname, origin = `https://${host}`;
    if (!loopback(req.socket.remoteAddress) || req.headers.host !== host) throw new Error("host");
    if (websocket || !["GET", "HEAD"].includes(req.method ?? "") ? req.headers.origin !== origin : req.headers.origin && req.headers.origin !== origin) throw new Error("origin");
    if (!["GET", "HEAD"].includes(req.method ?? "") && req.headers["sec-fetch-site"] === "cross-site") throw new Error("cross-site");
    const assertion = req.headers["cf-access-jwt-assertion"];
    if (typeof assertion !== "string" || assertion.length > 16384) throw new Error("assertion");
    const id = await this.verify(assertion);
    if (id.expires <= Date.now() || this.revoked.has(id.fingerprint)) throw new Error("expired");
    return id;
  }
  path(req) {
    if (!req.url?.startsWith("/") || req.url.startsWith("//")) throw new Error("path");
    const decoded = decodeURIComponent(req.url.split("?")[0]);
    if (decoded.includes("\\")) throw new Error("path");
    return new URL(decoded, "http://local.invalid").pathname;
  }
  upstreamHeaders(req, cookie, ws = false) {
    const headers = clean(req.headers, ws), host = `127.0.0.1:${this.options.native.port}`;
    headers.host = host;
    headers.origin = `http://${host}`;
    headers.cookie = cookie;
    return headers;
  }
  async handle(req, res) {
    let id;
    try {
      id = await this.identity(req);
    } catch {
      if (req.method === "GET" && req.headers["sec-fetch-mode"] === "navigate" && req.headers["sec-fetch-dest"] === "document") {
        res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" });
        res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\u8BF7\u91CD\u65B0\u767B\u5F55</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:440px;margin:15vh auto;padding:24px;color:#27272a}h1{font-size:24px}a{display:inline-block;color:#fff;background:#27272a;border-radius:6px;padding:8px 18px;text-decoration:none}</style><h1>\u8BF7\u91CD\u65B0\u767B\u5F55</h1><p>\u5F53\u524D\u8BA4\u8BC1\u65E0\u6548\u6216\u5DF2\u8FC7\u671F\u3002\u9000\u51FA\u540E\uFF0C\u91CD\u65B0\u6253\u5F00\u6B64\u5730\u5740\u767B\u5F55\u3002</p><a href="/cdn-cgi/access/logout">\u9000\u51FA\u5F53\u524D\u767B\u5F55</a></html>');
      } else json(res, 403, { error: "\u9700\u8981\u6709\u6548\u7684 Cloudflare Access \u8BA4\u8BC1\u3002" });
      return;
    }
    const path = this.path(req);
    if (path === `${PREFIX}/session` && req.method === "GET") {
      json(res, 200, { remote: true, email: id.email, expires: id.expires, deviceChecks: this.options.deployment.postureChecks.length });
      return;
    }
    if (path === `${PREFIX}/lease` && req.method === "POST") {
      this.leases.set(id.fingerprint, Date.now());
      json(res, 200, { ok: true });
      return;
    }
    if (path === `${PREFIX}/logout` && req.method === "POST") {
      this.revoked.set(id.fingerprint, id.expires);
      for (const [socket, entry] of this.active) if (entry.identity.fingerprint === id.fingerprint) socket.destroy();
      json(res, 200, { ok: true });
      return;
    }
    if (path === PREFIX || path.startsWith(`${PREFIX}/`)) {
      json(res, 403, { error: "\u4EC5\u5141\u8BB8\u5728\u672C\u673A\u914D\u7F6E Cloudflare\u3002" });
      return;
    }
    if (new URL(req.url, "http://local.invalid").searchParams.has("token")) {
      json(res, 400, { error: "\u4E0D\u63A5\u53D7\u672C\u673A\u542F\u52A8\u51ED\u636E\u3002" });
      return;
    }
    const cookie = await this.options.native.get();
    const upstream = request({ agent: false, hostname: "127.0.0.1", port: this.options.native.port, path: req.url, method: req.method, headers: this.upstreamHeaders(req, cookie) }, (response) => {
      if (response.statusCode === 401) {
        this.options.native.reset();
        response.resume();
        json(res, 503, { error: "\u672C\u673A\u4F1A\u8BDD\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u91CD\u8BD5\u3002\u8BF7\u6C42\u672A\u88AB\u81EA\u52A8\u91CD\u653E\u3002" });
        return;
      }
      const headers = clean(response.headers);
      headers["cache-control"] = "no-store";
      headers["referrer-policy"] = "no-referrer";
      if (headers.location && (!headers.location.startsWith("/") || headers.location.startsWith("//") || headers.location.includes("token="))) {
        response.destroy();
        json(res, 502, { error: "\u62D2\u7EDD\u4E86\u975E\u9884\u671F\u7684\u4E0A\u6E38\u91CD\u5B9A\u5411\u3002" });
        return;
      }
      res.writeHead(response.statusCode ?? 502, headers);
      response.pipe(res);
      response.on("error", () => res.destroy());
    });
    upstream.on("socket", (socket) => this.track(socket, id));
    upstream.on("error", () => {
      if (!res.headersSent) json(res, 502, { error: "\u672C\u673A Harness \u6682\u4E0D\u53EF\u7528\u3002" });
      else res.destroy();
    });
    res.on("close", () => upstream.destroy());
    req.on("aborted", () => upstream.destroy());
    req.pipe(upstream);
  }
  async upgrade(req, socket, head) {
    socket.on("error", () => socket.destroy());
    let id;
    try {
      id = await this.identity(req, true);
    } catch {
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      return;
    }
    const path = this.path(req);
    if (path === PREFIX || path.startsWith(`${PREFIX}/`)) {
      socket.destroy();
      return;
    }
    const cookie = await this.options.native.get();
    const upstream = request({ agent: false, hostname: "127.0.0.1", port: this.options.native.port, path: req.url, method: "GET", headers: this.upstreamHeaders(req, cookie, true) });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      upstreamSocket.on("error", () => socket.destroy());
      const headers = clean(response.headers, true);
      const lines = Object.entries(headers).flatMap(([key, values]) => (Array.isArray(values) ? values : [values]).filter((v) => v !== void 0).map((v) => `${key}: ${v}`));
      socket.write(`HTTP/1.1 101 Switching Protocols\r
${lines.join("\r\n")}\r
\r
`);
      if (head.length) upstreamSocket.write(head);
      if (upstreamHead.length) socket.write(upstreamHead);
      this.track(socket, id);
      this.track(upstreamSocket, id);
      socket.pipe(upstreamSocket).pipe(socket);
      socket.once("close", () => upstreamSocket.destroy());
      upstreamSocket.once("close", () => socket.destroy());
    });
    upstream.on("response", (response) => {
      if (response.statusCode === 401) this.options.native.reset();
      response.resume();
      socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    });
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
    upstream.end();
  }
};

// src/provision.ts
var Provisioner = class {
  constructor(store, vault, gatewayPort) {
    this.store = store;
    this.vault = vault;
    this.gatewayPort = gatewayPort;
  }
  store;
  vault;
  gatewayPort;
  get marker() {
    return `dsh-cloudflare-access-${this.store.state.installationId}`;
  }
  ownsApp(app) {
    return app.name === this.marker || app.id === this.store.state.deployment?.appId;
  }
  async discover(api) {
    const zones = await api.list("/zones");
    return zones.map((z2) => ({ id: z2.id, name: z2.name, accountId: z2.account.id, accountName: z2.account.name }));
  }
  async providers(api, accountId) {
    if (!/^[a-f0-9]{32}$/i.test(accountId)) fail("INPUT", "\u8D26\u53F7 ID \u683C\u5F0F\u9519\u8BEF\u3002");
    return (await api.list(`/accounts/${accountId}/access/identity_providers`)).map((p) => ({ id: p.id, name: String(p.name), type: String(p.type) }));
  }
  async preview(api, raw) {
    const setup = validateSetup(raw), a = `/accounts/${setup.accountId}`;
    const existing = this.store.state.deployment;
    if (existing && !sameSetup(existing, setup)) fail("EXISTING_DEPLOYMENT", "\u672C\u5B9E\u4F8B\u5DF2\u6709\u90E8\u7F72\u3002\u4E3A\u907F\u514D\u8986\u76D6\uFF0C\u8BF7\u5148\u505C\u7528\u5E76\u6E05\u7406\u672C\u63D2\u4EF6\u521B\u5EFA\u7684\u8D44\u6E90\uFF0C\u6216\u4F7F\u7528\u72EC\u7ACB\u914D\u7F6E\u76EE\u5F55\u3002");
    const [zone, org, providers, apps, dns, tunnels] = await Promise.all([
      api.request("GET", `/zones/${setup.zoneId}`),
      api.request("GET", `${a}/access/organizations`),
      api.list(`${a}/access/identity_providers`),
      api.list(`${a}/access/apps`),
      api.list(`/zones/${setup.zoneId}/dns_records?name=${encodeURIComponent(setup.hostname)}`),
      api.list(`${a}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(this.marker)}`)
    ]);
    if (zone.account.id !== setup.accountId || !setup.hostname.endsWith(`.${zone.name}`)) fail("ZONE", "\u5FC5\u987B\u9009\u62E9\u8BE5\u8D26\u53F7\u4E0B\u7684\u5B50\u57DF\u540D\uFF0C\u4E0D\u80FD\u8986\u76D6\u6839\u57DF\u540D\u3002");
    for (const app of apps) if (applicationMatches(app, setup.hostname) && (!this.ownsApp(app) || app.domain !== setup.hostname || app.type !== "self_hosted")) fail("APP_CONFLICT", "\u8BE5\u57DF\u540D\u5DF2\u6709 Access \u5E94\u7528\uFF08\u5305\u62EC\u901A\u914D\u7B26\u6216\u8DEF\u5F84\u5E94\u7528\uFF09\uFF1B\u4E0D\u4F1A\u8986\u76D6\uFF0C\u8BF7\u9009\u62E9\u65B0\u5B50\u57DF\u540D\u3002");
    if (apps.some((app) => this.ownsApp(app) && (app.domain !== setup.hostname || app.type !== "self_hosted"))) fail("OWNERSHIP", "\u672C\u63D2\u4EF6\u7684 Access \u5E94\u7528\u5DF2\u88AB\u4FEE\u6539\uFF0C\u8BF7\u5148\u4EBA\u5DE5\u6838\u5BF9\uFF0C\u4E0D\u4F1A\u53E6\u5EFA\u540C\u540D\u8D44\u6E90\u3002");
    if (tunnels.some((t) => t.config_src !== "cloudflare")) fail("TUNNEL_MODE", "\u672C\u63D2\u4EF6\u7684 Tunnel \u914D\u7F6E\u6A21\u5F0F\u4E0D\u4E00\u81F4\uFF0C\u62D2\u7EDD\u8986\u76D6\u3002");
    for (const record of dns) if (record.comment !== this.marker || record.type !== "CNAME" || !tunnels.some((t) => record.content === `${t.id}.cfargotunnel.com`)) fail("DNS_CONFLICT", "\u8BE5\u5B50\u57DF\u540D\u5DF2\u6709 DNS \u8BB0\u5F55\uFF1B\u4E0D\u4F1A\u8986\u76D6\uFF0C\u8BF7\u9009\u62E9\u65B0\u5B50\u57DF\u540D\u3002");
    if (apps.filter((x) => this.ownsApp(x)).length > 1 || tunnels.length > 1 || dns.length > 1) fail("AMBIGUOUS", "\u53D1\u73B0\u91CD\u590D\u7684\u90E8\u7F72\u8D44\u6E90\uFF0C\u8BF7\u5148\u5728 Cloudflare \u6838\u5BF9\u3002");
    const idp = providers.find((x) => setup.identityProvider === "otp" ? x.type === "onetimepin" : x.id === setup.identityProvider);
    if (!idp && setup.identityProvider !== "otp") fail("IDP", "\u6240\u9009\u767B\u5F55\u65B9\u5F0F\u4E0D\u5B58\u5728\u6216\u5DF2\u88AB\u79FB\u9664\u3002");
    if (setup.postureChecks.length) {
      const available = await api.list(`${a}/devices/posture`);
      if (setup.postureChecks.some((id) => !available.some((x) => x.id === id))) fail("POSTURE", "\u8BBE\u5907\u68C0\u67E5\u4E0D\u5B58\u5728\uFF1B\u4E0D\u4F1A\u964D\u7EA7\u4E3A\u4EC5\u8EAB\u4EFD\u8BA4\u8BC1\u3002");
    }
    return { setup, authDomain: authDomain(org.auth_domain), zoneName: zone.name, idpId: idp?.id, createOtp: !idp, resume: !!existing };
  }
  async provision(api, preview) {
    const checked = await this.preview(api, preview.setup);
    const d = this.store.state.deployment ?? { ...checked.setup, authDomain: checked.authDomain, zoneName: checked.zoneName, gatewayPort: this.gatewayPort };
    this.store.state.deployment = d;
    this.store.state.phase = "provisioning";
    this.store.state.enabled = false;
    delete this.store.state.lastError;
    await this.store.save();
    const a = `/accounts/${d.accountId}`, z2 = `/zones/${d.zoneId}`;
    let idpId = checked.idpId;
    if (!idpId) {
      const idp = await api.request("POST", `${a}/access/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} });
      idpId = idp.id;
    }
    let app = (await api.list(`${a}/access/apps`)).find((x) => this.ownsApp(x) && x.domain === d.hostname);
    if (!app) app = await api.request("POST", `${a}/access/apps`, {
      name: this.marker,
      type: "self_hosted",
      domain: d.hostname,
      session_duration: "1h",
      allowed_idps: [idpId],
      auto_redirect_to_identity: true,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: "lax",
      app_launcher_visible: true
    });
    if (typeof app.aud !== "string" || !app.aud || app.type !== "self_hosted" || app.domain !== d.hostname) fail("APP_INVALID", "Access \u5E94\u7528\u54CD\u5E94\u7F3A\u5C11\u6709\u6548 audience\uFF1B\u53D1\u5E03\u5DF2\u505C\u6B62\u3002");
    d.appId = app.id;
    d.audience = app.aud;
    await this.store.save();
    if (app.name === this.marker) {
      await api.request("PUT", `${a}/access/apps/${app.id}`, {
        name: "DeepSeek Harness",
        type: "self_hosted",
        domain: d.hostname,
        session_duration: "1h",
        allowed_idps: [idpId],
        auto_redirect_to_identity: true,
        http_only_cookie_attribute: true,
        same_site_cookie_attribute: "lax",
        app_launcher_visible: true
      });
    }
    const expected = {
      name: this.marker,
      decision: "allow",
      precedence: 1,
      include: d.emails.map((email) => ({ email: { email } })),
      exclude: [],
      require: [{ login_method: { id: idpId } }, ...d.postureChecks.map((id) => ({ device_posture: { integration_uid: id } }))]
    };
    const policies = await api.list(`${a}/access/apps/${app.id}/policies`);
    let policy = policies[0];
    if (policies.length > 1 || policy && !policyMatches(policy, expected)) fail("POLICY_DRIFT", "Access \u7B56\u7565\u4E0E\u9884\u89C8\u4E0D\u4E00\u81F4\uFF1B\u4E0D\u4F1A\u8986\u76D6\u6216\u653E\u5BBD\u5DF2\u6709\u7B56\u7565\u3002");
    if (!policy) policy = await api.request("POST", `${a}/access/apps/${app.id}/policies`, expected);
    d.policyId = policy.id;
    await this.store.save();
    const readback = await api.list(`${a}/access/apps/${app.id}/policies`);
    if (readback.length !== 1 || !policyMatches(readback[0], expected)) fail("POLICY_VERIFY", "\u8BA4\u8BC1\u7B56\u7565\u56DE\u8BFB\u9A8C\u8BC1\u5931\u8D25\uFF1B\u6CA1\u6709\u53D1\u5E03\u57DF\u540D\u3002");
    let tunnel = (await api.list(`${a}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(this.marker)}`))[0];
    if (!tunnel) tunnel = await api.request("POST", `${a}/cfd_tunnel`, { name: this.marker, config_src: "cloudflare" });
    d.tunnelId = tunnel.id;
    await this.store.save();
    await api.request("PUT", `${a}/cfd_tunnel/${tunnel.id}/configurations`, { config: { ingress: [
      { hostname: d.hostname, service: `http://127.0.0.1:${d.gatewayPort}`, originRequest: { access: {
        required: true,
        teamName: d.authDomain.replace(".cloudflareaccess.com", ""),
        audTag: [d.audience]
      } } },
      { service: "http_status:404" }
    ] } });
    const token = await api.request("GET", `${a}/cfd_tunnel/${tunnel.id}/token`);
    if (typeof token !== "string" || token.length < 20) fail("TUNNEL_TOKEN", "\u6CA1\u6709\u53D6\u5F97\u6709\u6548\u7684 Tunnel \u8FD0\u884C\u51ED\u636E\u3002");
    await this.vault.set(token);
    const records = await api.list(`${z2}/dns_records?name=${encodeURIComponent(d.hostname)}`);
    if (records.some((r) => r.comment !== this.marker || r.type !== "CNAME" || r.content !== `${tunnel.id}.cfargotunnel.com`)) fail("DNS_CONFLICT", "\u53D1\u5E03\u671F\u95F4\u53D1\u73B0 DNS \u51B2\u7A81\uFF0C\u5DF2\u505C\u6B62\uFF1B\u8BA4\u8BC1\u8D44\u6E90\u4FDD\u7559\u4F9B\u6062\u590D\u3002");
    if (records.some((r) => r.proxied !== true) || records.length > 1) fail("DNS_DRIFT", "\u672C\u63D2\u4EF6\u7684 DNS \u4EE3\u7406\u72B6\u6001\u6216\u8BB0\u5F55\u6570\u91CF\u5DF2\u6539\u53D8\uFF0C\u8BF7\u4EBA\u5DE5\u6838\u5BF9\u3002");
    const dns = records[0] ?? await api.request("POST", `${z2}/dns_records`, {
      type: "CNAME",
      name: d.hostname,
      content: `${tunnel.id}.cfargotunnel.com`,
      proxied: true,
      ttl: 1,
      comment: this.marker
    });
    d.dnsId = dns.id;
    this.store.state.phase = "configured";
    await this.store.save();
    return d;
  }
  /** Caller must stop local serving first. Only recorded, verified owned resources. */
  async cleanup(api, confirmedHostname) {
    const d = this.store.state.deployment;
    if (!d || confirmedHostname !== d.hostname) fail("CONFIRM", "\u8BF7\u5B8C\u6574\u8F93\u5165\u5F53\u524D\u57DF\u540D\u786E\u8BA4\u6E05\u7406\u3002");
    if (this.store.state.enabled) fail("RUNNING", "\u8BF7\u5148\u505C\u7528\u8FDC\u7A0B\u5165\u53E3\u3002");
    const a = `/accounts/${d.accountId}`, z2 = `/zones/${d.zoneId}`;
    const apps = (await api.list(`${a}/access/apps`)).filter((x) => this.ownsApp(x));
    const tunnels = await api.list(`${a}/cfd_tunnel?is_deleted=false&name=${encodeURIComponent(this.marker)}`);
    const dns = (await api.list(`${z2}/dns_records?name=${encodeURIComponent(d.hostname)}`)).filter((x) => x.comment === this.marker);
    if (apps.length > 1 || tunnels.length > 1 || dns.length > 1) fail("AMBIGUOUS", "\u8D44\u6E90\u91CD\u590D\uFF0C\u8BF7\u5728 Cloudflare \u624B\u52A8\u6838\u5BF9\u540E\u518D\u6E05\u7406\u3002");
    if (apps.some((x) => x.domain !== d.hostname || x.type !== "self_hosted") || dns.some((x) => x.type !== "CNAME" || x.content !== `${tunnels[0]?.id ?? d.tunnelId}.cfargotunnel.com`)) fail("OWNERSHIP", "\u8D44\u6E90\u4E0E\u672C\u63D2\u4EF6\u8BB0\u5F55\u4E0D\u4E00\u81F4\uFF0C\u62D2\u7EDD\u5220\u9664\u3002");
    for (const r of dns) await api.request("DELETE", `${z2}/dns_records/${r.id}`);
    for (const t of tunnels) await api.request("DELETE", `${a}/cfd_tunnel/${t.id}`);
    for (const app of apps) await api.request("DELETE", `${a}/access/apps/${app.id}`);
    await this.vault.clear();
    delete this.store.state.deployment;
    delete this.store.state.lastError;
    this.store.state.phase = "unconfigured";
    await this.store.save();
  }
};
function policyMatches(actual, expected) {
  const canonical = (v) => JSON.stringify(Array.isArray(v) ? [...v].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) : v);
  return actual.name === expected.name && actual.decision === "allow" && ["include", "require", "exclude"].every((key) => canonical(actual[key] ?? []) === canonical(expected[key] ?? []));
}

// src/controller.ts
var Controller = class {
  constructor(store, vault, native, gatewayPort, cloudflaredPath) {
    this.store = store;
    this.vault = vault;
    this.native = native;
    this.provisioner = new Provisioner(store, vault, gatewayPort);
    this.connector = new Connector(store.directory, cloudflaredPath, () => {
      void this.gateway?.stop();
      this.gateway = void 0;
    });
  }
  store;
  vault;
  native;
  provisioner;
  connector;
  gateway;
  plan;
  planTimer;
  busy = false;
  disposed = false;
  current;
  async init() {
    await this.store.load();
    if (this.store.state.enabled) {
      try {
        await this.start();
      } catch (error) {
        this.store.state.lastError = publicError(error).message;
        await this.store.save();
      }
    }
  }
  status() {
    const { state } = this.store;
    return { remote: false, phase: state.phase, enabled: state.enabled, running: !!this.gateway, connector: this.connector.status, busy: this.busy, deployment: state.deployment, lastError: state.lastError };
  }
  async execute(action, body2) {
    if (this.disposed) fail("DISPOSED", "\u63D2\u4EF6\u6B63\u5728\u505C\u6B62\u3002", 503);
    if (this.busy) fail("BUSY", "\u53E6\u4E00\u4E2A\u64CD\u4F5C\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u7A0D\u540E\u3002", 409);
    this.busy = true;
    this.current = this.dispatch(action, body2);
    try {
      return await this.current;
    } catch (error) {
      this.store.state.lastError = publicError(error).message;
      await this.store.save();
      throw error;
    } finally {
      this.busy = false;
      this.current = void 0;
    }
  }
  async dispatch(action, body2) {
    const api = () => new Cloudflare(body2.token);
    switch (action) {
      case "discover":
        return this.provisioner.discover(api());
      case "providers":
        return this.provisioner.providers(api(), String(body2.accountId));
      case "preview": {
        this.clearPlan();
        const client = api(), preview = await this.provisioner.preview(client, body2.setup);
        const plan = { id: randomUUID2(), api: client, preview, expires: Date.now() + 6e5 };
        this.plan = plan;
        this.planTimer = setTimeout(() => this.clearPlan(), 6e5);
        this.planTimer.unref();
        return { planId: plan.id, expires: plan.expires, ...preview };
      }
      case "provision": {
        const plan = this.plan;
        if (!plan || plan.id !== body2.planId || plan.expires < Date.now() || body2.hostname !== plan.preview.setup.hostname) fail("PLAN", "\u9884\u89C8\u5DF2\u8FC7\u671F\u6216\u672A\u786E\u8BA4\u57DF\u540D\uFF0C\u8BF7\u91CD\u65B0\u9884\u89C8\u3002");
        this.clearPlan();
        if (this.gateway) fail("RUNNING", "\u8BF7\u5148\u505C\u7528\u5165\u53E3\u3002");
        if (!await this.connector.executable()) fail("CONNECTOR_MISSING", "\u8BF7\u5148\u5B89\u88C5\u5B98\u65B9 cloudflared\uFF0C\u518D\u53D1\u5E03\u3002");
        await this.provisioner.provision(plan.api, plan.preview);
        await this.start();
        return this.status();
      }
      case "install-connector":
        await this.connector.install();
        return { installed: true };
      case "start":
        await this.start();
        return this.status();
      case "stop":
        await this.stop();
        return this.status();
      case "cleanup":
        await this.stop();
        await this.provisioner.cleanup(api(), String(body2.hostname));
        return this.status();
      default:
        fail("NOT_FOUND", "\u4E0D\u5B58\u5728\u7684\u64CD\u4F5C\u3002", 404);
    }
  }
  clearPlan() {
    clearTimeout(this.planTimer);
    this.plan = void 0;
  }
  async start() {
    if (this.gateway) return;
    const d = this.store.state.deployment;
    if (this.store.state.phase !== "configured" || !d?.dnsId || !d.audience) fail("NOT_CONFIGURED", "\u8BF7\u5148\u5B8C\u6210\u90E8\u7F72\u914D\u7F6E\u3002");
    const token = await this.vault.get();
    if (!token) fail("CREDENTIAL", "Tunnel \u8FD0\u884C\u51ED\u636E\u4E22\u5931\uFF0C\u8BF7\u4F7F\u7528\u539F\u914D\u7F6E\u91CD\u65B0\u9884\u89C8\u5E76\u6062\u590D\u3002");
    const gateway = new Gateway({ deployment: d, native: this.native });
    try {
      await gateway.start();
      this.gateway = gateway;
      await this.connector.start(token);
      this.store.state.enabled = true;
      delete this.store.state.lastError;
      await this.store.save();
    } catch (error) {
      await this.connector.stop();
      await gateway.stop();
      this.gateway = void 0;
      throw error;
    }
  }
  async stop() {
    this.store.state.enabled = false;
    await this.store.save();
    await this.connector.stop();
    await this.gateway?.stop();
    this.gateway = void 0;
  }
  async dispose() {
    this.disposed = true;
    this.clearPlan();
    await this.current?.catch(() => {
    });
    this.clearPlan();
    await this.connector.stop();
    await this.gateway?.stop();
    this.gateway = void 0;
  }
};

// src/index.ts
var name = "dsh-cloudflare-access";
var inject = ["webServer", "connection", "credentials"];
var Config = z.object({ instance: z.string().default("web"), gatewayPort: z.natural().min(1024).max(65535).default(3082), dataDir: z.string(), cloudflaredPath: z.string() });
async function body(req) {
  if (!String(req.headers["content-type"]).startsWith("application/json")) fail("CONTENT_TYPE", "\u9700\u8981 JSON \u8BF7\u6C42\u3002", 415);
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) fail("BODY_SIZE", "\u8BF7\u6C42\u8FC7\u5927\u3002", 413);
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString());
    if (value && typeof value === "object" && !Array.isArray(value)) return value;
  } catch {
  }
  fail("JSON", "JSON \u683C\u5F0F\u9519\u8BEF\u3002");
}
async function apply(ctx, config) {
  if (!/^[a-z0-9-]{1,40}$/.test(config.instance)) fail("INSTANCE", "instance \u4EC5\u652F\u6301\u5C0F\u5199\u5B57\u6BCD\u3001\u6570\u5B57\u548C\u8FDE\u5B57\u7B26\u3002");
  if (ctx.webServer.host !== "127.0.0.1") fail("BIND", "\u4F7F\u7528 Cloudflare \u63D2\u4EF6\u65F6\uFF0C\u5B98\u65B9 webServer \u5FC5\u987B\u4EC5\u76D1\u542C 127.0.0.1\u3002");
  if (config.gatewayPort === ctx.webServer.port) fail("PORT", "\u5165\u53E3\u7AEF\u53E3\u4E0D\u80FD\u4E0E Harness \u7AEF\u53E3\u76F8\u540C\u3002");
  const directory = config.dataDir ?? join3(process.env.DSH_HOME ?? join3(homedir2(), ".dsh"), "dsh-cloudflare-access", config.instance);
  if (!isAbsolute(directory) || config.cloudflaredPath && !isAbsolute(config.cloudflaredPath)) fail("PATH", "\u8BF7\u4F7F\u7528\u7EDD\u5BF9\u8DEF\u5F84\u3002");
  await mkdir2(directory, { recursive: true, mode: 448 });
  let controller;
  let compromised = false;
  const release = await lockfile.lock(directory, { lockfilePath: join3(directory, "instance.lock"), stale: 3e4, update: 1e4, retries: 0, onCompromised: () => {
    compromised = true;
    void controller?.dispose();
  } }).catch(() => fail("INSTANCE_LOCK", "\u8BE5\u914D\u7F6E\u76EE\u5F55\u6B63\u5728\u88AB\u53E6\u4E00\u4E2A\u5B9E\u4F8B\u4F7F\u7528\uFF0C\u6216\u4E0A\u6B21\u5F02\u5E38\u9000\u51FA\u5C1A\u672A\u8D85\u8FC7 30 \u79D2\u3002"));
  ctx.effect(() => () => release().catch(() => {
  }), "cloudflare instance lock");
  const store = new StateStore(directory);
  await store.load();
  const ref = credentialRef(`DSH_CLOUDFLARE_ACCESS_${store.state.installationId.replaceAll("-", "_").toUpperCase()}_TUNNEL`);
  controller = new Controller(store, {
    set: (value) => ctx.credentials.set(ref, value),
    get: async () => (await ctx.credentials.resolve(ref))?.value,
    clear: () => ctx.credentials.unset(ref)
  }, new NativeSession(ctx.webServer.port, (base) => ctx.connection.authenticatedUrl(base)), config.gatewayPort, config.cloudflaredPath);
  const activeController = controller;
  ctx.effect(() => () => activeController.dispose(), "cloudflare lifecycle");
  await controller.init();
  if (compromised) {
    await controller.dispose();
    fail("INSTANCE_LOCK", "\u672C\u673A\u5B9E\u4F8B\u9501\u5931\u6548\uFF0C\u5165\u53E3\u5DF2\u505C\u6B62\u3002");
  }
  ctx.effect(() => ctx.webServer.register({ kind: "prefix", path: PREFIX, handler: async (req, res) => {
    if (!localAdmin(req, ctx.webServer.port, !ctx.connection.requestRejection(req))) {
      json(res, 403, { error: "Cloudflare \u914D\u7F6E\u4EC5\u5141\u8BB8\u672C\u673A\u5DF2\u8BA4\u8BC1\u6D4F\u89C8\u5668\u8BBF\u95EE\u3002" });
      return;
    }
    try {
      const path = new URL(req.url, "http://local.invalid").pathname.slice(PREFIX.length);
      if (compromised) fail("INSTANCE_LOCK", "\u672C\u673A\u5B9E\u4F8B\u9501\u5931\u6548\uFF0C\u5165\u53E3\u5DF2\u505C\u6B62\u3002", 503);
      if (req.method === "GET" && (path === "/status" || path === "/session")) {
        json(res, 200, activeController.status());
        return;
      }
      if (req.method !== "POST" || !/^\/[a-z-]+$/.test(path)) {
        json(res, 404, { error: "Not found" });
        return;
      }
      const result = await activeController.execute(path.slice(1), await body(req));
      json(res, 200, result);
    } catch (error) {
      json(res, error instanceof UserError ? error.status : 500, { error: publicError(error).message, code: publicError(error).code });
    }
  } }), "cloudflare local settings");
}
export {
  Config,
  apply,
  inject,
  name
};
//# sourceMappingURL=index.js.map

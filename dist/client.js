window.__ModuleLoader__.load({id:"@sevoniva/dsh-cloudflare-access",factory:function(require){const module={exports:{}};const exports=module.exports;"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/client.ts
var client_exports = {};
__export(client_exports, {
  createClient: () => createClient
});
module.exports = __toCommonJS(client_exports);

// src/model.ts
var PREFIX = "/__dsh_cloudflare_access";

// src/session-recovery.ts
var ProbeError = class extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
  kind;
};
async function probeLease(signal, fetcher = fetch) {
  let response;
  try {
    response = await fetcher(`${PREFIX}/lease`, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      cache: "no-store",
      signal,
      headers: { "content-type": "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: "{}"
    });
  } catch {
    throw new ProbeError("network");
  }
  if (response.type === "opaqueredirect" || response.status === 401) throw new ProbeError("login");
  if (response.status === 403) throw new ProbeError("denied");
  if (!response.ok) throw new ProbeError("unavailable");
  let value;
  try {
    value = await response.json();
  } catch {
    throw new ProbeError("unavailable");
  }
  if (value.ok !== true || typeof value.sessionId !== "string" || !value.sessionId || typeof value.principal !== "string" || !value.principal || !Number.isFinite(value.expires) || !Number.isFinite(value.leaseMs) || value.leaseMs < 1e3) throw new ProbeError("unavailable");
  return value;
}
var SessionRecovery = class {
  constructor(options) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }
  options;
  stopped = false;
  accountChanged = false;
  pending;
  queued = false;
  timer;
  probeAbort;
  authAbort;
  unsubscribe;
  lease;
  failedSince;
  silentAttempted = false;
  needsReconnect = false;
  lastReconnect = -Infinity;
  lastSuccess = -Infinity;
  state;
  now;
  start() {
    this.unsubscribe = this.options.connection.state.subscribe(() => {
      if (this.stopped || this.accountChanged) return;
      if (this.options.connection.state.getSnapshot() === "connected" && this.failedSince === void 0 && this.lease) this.show("connected");
      else if (this.options.connection.state.getSnapshot() !== "connected") this.schedule(1e3);
    });
    void this.check();
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.probeAbort?.abort();
    this.authAbort?.abort();
    this.unsubscribe?.();
  }
  wake() {
    if (this.stopped || this.accountChanged) return;
    const state = this.options.connection.state.getSnapshot();
    this.needsReconnect ||= state === "disconnected" || state === "connected" && this.lease !== void 0 && this.now() - this.lastSuccess > this.lease.leaseMs / 2;
    void this.check();
  }
  networkChanged() {
    if (this.stopped || this.accountChanged) return;
    if (this.options.online?.() === false) {
      this.probeAbort?.abort();
      this.authAbort?.abort();
      this.needsReconnect = true;
      this.show("offline");
    } else this.wake();
  }
  /** Must be called directly from a user gesture so a login window is allowed. */
  login() {
    if (this.stopped || this.accountChanged) return;
    this.authAbort?.abort();
    const abort = this.authAbort = new AbortController();
    const result = this.options.authenticate(true, abort.signal);
    void result.then(() => {
      if (!abort.signal.aborted && !this.stopped) {
        this.needsReconnect = true;
        void this.check();
      }
    }, () => {
    }).finally(() => {
      if (this.authAbort === abort) this.authAbort = void 0;
    });
  }
  check() {
    if (this.stopped || this.accountChanged) return Promise.resolve();
    if (this.pending) {
      this.queued = true;
      return this.pending;
    }
    clearTimeout(this.timer);
    this.pending = this.run().finally(() => {
      this.pending = void 0;
      if (this.queued) {
        this.queued = false;
        if (!this.stopped) this.schedule(0);
      }
    });
    return this.pending;
  }
  show(state) {
    if (!this.stopped && (!this.accountChanged || state === "account-changed") && this.state !== state) {
      this.state = state;
      this.options.render(state);
    }
  }
  schedule(delay) {
    if (this.stopped || this.accountChanged) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.check();
    }, delay);
  }
  async run() {
    if (this.options.online?.() === false) {
      this.show("offline");
      this.schedule(3e4);
      return;
    }
    const abort = this.probeAbort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 8e3);
    try {
      const lease = await this.options.probe(abort.signal);
      if (this.stopped) return;
      if (this.lease && lease.principal !== this.lease.principal) {
        this.accountChanged = true;
        this.queued = false;
        this.needsReconnect = false;
        clearTimeout(this.timer);
        this.authAbort?.abort();
        this.authAbort = void 0;
        this.show("account-changed");
        return;
      }
      const recovered = this.failedSince !== void 0;
      const changed = this.lease !== void 0 && this.lease.sessionId !== lease.sessionId;
      this.lease = lease;
      this.lastSuccess = this.now();
      this.failedSince = void 0;
      this.silentAttempted = false;
      this.authAbort?.abort();
      this.authAbort = void 0;
      this.needsReconnect ||= changed || recovered;
      if (this.needsReconnect && this.now() - this.lastReconnect >= 3e3) {
        this.needsReconnect = false;
        this.lastReconnect = this.now();
        this.options.connection.reconnect();
      }
      this.show(this.options.connection.state.getSnapshot() === "connected" ? "connected" : "recovering");
      const expiryDelay = lease.expires - this.now() + 250;
      this.schedule(Math.max(1e3, Math.min(this.needsReconnect ? 3e3 : 3e4, lease.leaseMs / 3, expiryDelay)));
    } catch (error) {
      if (this.stopped) return;
      this.failedSince ??= this.now();
      this.needsReconnect = true;
      const kind = error instanceof ProbeError ? error.kind : "network";
      if (this.options.online?.() === false) this.show("offline");
      else if (kind === "denied") this.show("denied");
      else if (kind === "login") {
        if (!this.silentAttempted && !this.authAbort) {
          this.silentAttempted = true;
          this.show("recovering");
          const auth = this.authAbort = new AbortController();
          try {
            await this.options.authenticate(false, auth.signal);
            if (!this.stopped && !auth.signal.aborted) this.queued = true;
          } catch {
            if (!this.stopped && !auth.signal.aborted) this.show("login");
          } finally {
            if (this.authAbort === auth) this.authAbort = void 0;
          }
        } else this.show("login");
      } else if (this.now() - this.failedSince >= 5e3) this.show(kind === "unavailable" ? "unavailable" : "recovering");
      this.schedule(kind === "login" || kind === "denied" ? 3e4 : 5e3);
    } finally {
      clearTimeout(timeout);
      if (this.probeAbort === abort) this.probeAbort = void 0;
    }
  }
};
var AUTH_MESSAGE = "dsh-cloudflare-access:authenticated";
function authenticateBrowser(interactive, signal) {
  const state = crypto.randomUUID();
  const url = `${PREFIX}/auth/complete?state=${encodeURIComponent(state)}`;
  return new Promise((resolve, reject) => {
    let frame;
    let channel;
    let timer;
    const finish = (ok) => {
      clearTimeout(timer);
      frame?.remove();
      channel?.close();
      window.removeEventListener("message", message);
      signal.removeEventListener("abort", aborted);
      ok ? resolve() : reject(new Error("Authentication requires interaction"));
    };
    const aborted = () => finish(false);
    const message = (event) => {
      if (frame && event.origin === location.origin && event.source === frame.contentWindow && event.data?.type === AUTH_MESSAGE && event.data?.state === state) finish(true);
    };
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    signal.addEventListener("abort", aborted, { once: true });
    timer = setTimeout(() => finish(false), interactive ? 3e5 : 8e3);
    if (interactive) {
      if (typeof BroadcastChannel !== "undefined") {
        channel = new BroadcastChannel(AUTH_MESSAGE);
        channel.onmessage = (event) => {
          if (event.data?.state === state && event.data?.type === AUTH_MESSAGE) finish(true);
        };
      }
      window.open(url, "_blank", "noopener");
    } else {
      frame = document.createElement("iframe");
      frame.hidden = true;
      frame.title = "\u767B\u5F55\u72B6\u6001\u68C0\u67E5";
      frame.referrerPolicy = "no-referrer";
      window.addEventListener("message", message);
      frame.src = url;
      document.body.append(frame);
    }
  });
}
function installSessionRecovery(connection) {
  let banner;
  const labels = {
    recovering: "\u6B63\u5728\u6062\u590D\u8FDE\u63A5\u2026",
    offline: "\u7F51\u7EDC\u5DF2\u65AD\u5F00\uFF0C\u6062\u590D\u540E\u81EA\u52A8\u8FDE\u63A5\u3002",
    login: "\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u91CD\u65B0\u767B\u5F55\u3002",
    denied: "\u5F53\u524D\u8D26\u53F7\u65E0\u8BBF\u95EE\u6743\u9650\u3002",
    unavailable: "\u670D\u52A1\u6682\u4E0D\u53EF\u7528\uFF0C\u6B63\u5728\u91CD\u8BD5\u3002",
    "account-changed": "\u767B\u5F55\u8D26\u53F7\u5DF2\u66F4\u6362\uFF0C\u8BF7\u4FDD\u5B58\u8349\u7A3F\u540E\u91CD\u65B0\u6253\u5F00\u9875\u9762\u3002"
  };
  const recovery = new SessionRecovery({
    connection,
    probe: probeLease,
    authenticate: authenticateBrowser,
    online: () => navigator.onLine,
    render: (state) => {
      banner?.remove();
      banner = void 0;
      if (state === "connected") return;
      banner = document.createElement("div");
      banner.setAttribute("role", "status");
      banner.style.cssText = "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99999;background:#27272a;color:white;padding:12px 20px;border-radius:8px;box-shadow:0 4px 24px #0005;display:flex;align-items:center;gap:12px";
      const text = document.createElement("span");
      text.textContent = labels[state];
      banner.append(text);
      if (state !== "account-changed" && state !== "offline") {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = state === "login" ? "\u767B\u5F55" : "\u91CD\u8BD5";
        button.style.cssText = "color:inherit;background:none;border:1px solid #888;border-radius:4px;padding:4px 10px;cursor:pointer";
        button.onclick = () => state === "login" ? recovery.login() : recovery.wake();
        banner.append(button);
      }
      document.body.append(banner);
    }
  });
  const visible = () => {
    if (document.visibilityState === "visible") recovery.wake();
  };
  const wake = () => recovery.wake(), network = () => recovery.networkChanged();
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pageshow", wake);
  window.addEventListener("focus", wake);
  window.addEventListener("online", network);
  window.addEventListener("offline", network);
  recovery.start();
  return () => {
    recovery.stop();
    banner?.remove();
    document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("pageshow", wake);
    window.removeEventListener("focus", wake);
    window.removeEventListener("online", network);
    window.removeEventListener("offline", network);
  };
}

// src/client.ts
async function api(action, value) {
  const response = await fetch(`${PREFIX}/${action}`, { method: value === void 0 ? "GET" : "POST", credentials: "same-origin", redirect: "manual", headers: { "X-Requested-With": "XMLHttpRequest", ...value === void 0 ? {} : { "content-type": "application/json" } }, body: value === void 0 ? void 0 : JSON.stringify(value) });
  if (response.type === "opaqueredirect" || response.status === 401) throw new Error("\u767B\u5F55\u5DF2\u8FC7\u671F\uFF0C\u8BF7\u4F7F\u7528\u9875\u9762\u4E0B\u65B9\u7684\u767B\u5F55\u5165\u53E3\u3002");
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("\u670D\u52A1\u54CD\u5E94\u5F02\u5E38\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002");
  }
  if (!response.ok) throw new Error(result.error ?? `\u8BF7\u6C42\u5931\u8D25 (${response.status})`);
  return result;
}
function createClient(require2) {
  const R = require2("react"), h = R.createElement;
  const fieldStyle = { display: "block", width: "100%", boxSizing: "border-box", padding: "9px 11px", marginTop: 6, border: "1px solid #8885", borderRadius: 7, background: "transparent", color: "inherit", font: "inherit" };
  const buttonStyle = { padding: "9px 14px", border: "1px solid #8886", borderRadius: 7, background: "transparent", color: "inherit", cursor: "pointer", marginRight: 8, marginTop: 10 };
  function Panel() {
    const [status, setStatus] = R.useState(), [error, setError] = R.useState(""), [note, setNote] = R.useState(""), [busy, setBusy] = R.useState(false);
    const [token, setToken] = R.useState(""), [zones, setZones] = R.useState([]), [zoneId, setZone] = R.useState("");
    const [providers, setProviders] = R.useState([]), [provider, setProvider] = R.useState("otp");
    const [hostname, setHost] = R.useState(""), [emails, setEmails] = R.useState(""), [posture, setPosture] = R.useState(""), [preview, setPreview] = R.useState(), [confirmation, setConfirmation] = R.useState("");
    const refresh = async () => setStatus(await api("session"));
    R.useEffect(() => {
      void refresh().catch((e) => setError(e.message));
      const timer = setInterval(() => {
        void refresh().catch(() => {
        });
      }, 5e3);
      return () => clearInterval(timer);
    }, []);
    const task = (fn) => async () => {
      setBusy(true);
      setError("");
      setNote("");
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : "\u64CD\u4F5C\u5931\u8D25");
      } finally {
        setBusy(false);
      }
    };
    const field = (label, value, change, type = "text", placeholder = "") => h("label", { style: { display: "block", marginTop: 14 } }, label, h("input", { type, value, placeholder, autoComplete: type === "password" ? "off" : void 0, style: fieldStyle, disabled: busy, onChange: (e) => {
      change(e.target.value);
      setPreview(void 0);
    } }));
    const button = (label, action, disabled = false) => h("button", { type: "button", disabled: busy || disabled, style: buttonStyle, onClick: task(action) }, label);
    const box = (children) => h("section", { style: { padding: 18, border: "1px solid #8884", borderRadius: 10, marginTop: 16 } }, children);
    const d = status?.deployment;
    return h(
      "div",
      { style: { maxWidth: 780, margin: "0 auto", padding: 24, lineHeight: 1.6 } },
      h("h2", { style: { margin: 0 } }, "Cloudflare \u96F6\u4FE1\u4EFB\u63A5\u5165"),
      error && h("div", { role: "alert", style: { color: "#e56e63" } }, error),
      note && h("p", { role: "status" }, note),
      !status ? h("p", null, "\u52A0\u8F7D\u4E2D\u2026") : status.remote ? box(h(
        R.Fragment,
        null,
        h("h3", null, "\u5DF2\u767B\u5F55"),
        h("p", null, status.email),
        h("p", null, "\u5F53\u524D\u4F7F\u7528\u5171\u4EAB\u5DE5\u4F5C\u73AF\u5883\u3002"),
        h("p", null, "\u8BBF\u95EE\u8BBE\u7F6E\u8BF7\u5728\u8FD0\u884C Harness \u7684\u7535\u8111\u4E0A\u4FEE\u6539\u3002"),
        button("\u9000\u51FA\u767B\u5F55", async () => {
          await api("logout", {});
          location.assign("/cdn-cgi/access/logout");
        })
      )) : h(
        R.Fragment,
        null,
        box(h(
          R.Fragment,
          null,
          h("strong", null, status.running ? "\u5DF2\u542F\u7528" : "\u672A\u542F\u7528"),
          h("p", null, `\u96A7\u9053\uFF1A${{ stopped: "\u672A\u542F\u52A8", starting: "\u8FDE\u63A5\u4E2D", connected: "\u5DF2\u8FDE\u63A5", retrying: "\u7B49\u5F85\u91CD\u8FDE", failed: "\u8FDE\u63A5\u5931\u8D25" }[status.connector ?? "stopped"] ?? "\u672A\u77E5"}`),
          d && h("p", null, h("a", { href: `https://${d.hostname}`, target: "_blank", rel: "noreferrer" }, d.hostname)),
          d && h("p", null, `\u8BBE\u5907\u9A8C\u8BC1\uFF1A${d.postureChecks.length ? "\u5DF2\u914D\u7F6E" : "\u672A\u914D\u7F6E"}`),
          status.lastError && h("p", null, status.lastError),
          button("\u5B89\u88C5 cloudflared", async () => {
            await api("install-connector", {});
            setNote("cloudflared \u5B89\u88C5\u5B8C\u6210\u3002");
          }),
          d && button("\u542F\u7528", async () => {
            await api("start", {});
          }, !!status.running),
          d && button("\u505C\u7528", async () => {
            await api("stop", {});
            setNote("\u5DF2\u505C\u7528\uFF0C\u4E91\u7AEF\u914D\u7F6E\u4FDD\u7559\u3002");
          }, !status.enabled)
        )),
        box(h(
          R.Fragment,
          null,
          h("h3", null, "Cloudflare \u51ED\u636E"),
          h("p", null, "\u7528\u4E8E\u914D\u7F6E DNS\u3001Access \u548C Tunnel\u3002\u6B64 Token \u4E0D\u4FDD\u5B58\u3002"),
          field("API Token", token, setToken, "password"),
          button("\u9A8C\u8BC1\u5E76\u8BFB\u53D6\u57DF\u540D", async () => {
            const list = await api("discover", { token });
            setZones(list);
            setZone("");
            setPreview(void 0);
            setNote(`\u5DF2\u8BFB\u53D6 ${list.length} \u4E2A\u57DF\u540D\u3002`);
          }, !token),
          h("details", { style: { marginTop: 12, fontSize: 12, opacity: 0.75 } }, h("summary", null, "Token \u6743\u9650"), h("p", null, "Zone Read\u3001DNS Edit\u3001Cloudflare Tunnel Edit\u3001Access Apps & Policies Edit\u3001Access Organizations/Identity Providers Read\u3002\u521B\u5EFA\u90AE\u4EF6\u9A8C\u8BC1\u7801\u767B\u5F55\u65B9\u5F0F\u9700 Identity Providers Edit\uFF1B\u8BBE\u5907\u9A8C\u8BC1\u9700 Device Posture Read\u3002"))
        )),
        zones.length > 0 && box(h(
          R.Fragment,
          null,
          h("h3", null, "\u8BBF\u95EE\u8BBE\u7F6E"),
          h("label", null, "\u57DF\u540D", h("select", { "aria-label": "\u57DF\u540D", style: fieldStyle, value: zoneId, disabled: busy, onChange: (e) => {
            const zone = zones.find((z) => z.id === e.target.value);
            setZone(e.target.value);
            setPreview(void 0);
            setProviders([]);
            setProvider("otp");
            if (zone) {
              setHost(`harness.${zone.name}`);
              void task(async () => setProviders(await api("providers", { token, accountId: zone.accountId })))();
            }
          } }, h("option", { value: "" }, "\u8BF7\u9009\u62E9\u57DF\u540D"), ...zones.map((z) => h("option", { key: z.id, value: z.id }, `${z.name} \xB7 ${z.accountName}`)))),
          field("\u8BBF\u95EE\u5730\u5740", hostname, setHost, "text", "harness.example.com"),
          field("\u5141\u8BB8\u7684\u90AE\u7BB1", emails, setEmails, "text", "you@example.com"),
          h("p", { style: { margin: "4px 0", fontSize: 12, opacity: 0.75 } }, "\u591A\u4E2A\u90AE\u7BB1\u4EE5\u9017\u53F7\u5206\u9694\u3002"),
          h("label", { style: { display: "block", marginTop: 14 } }, "\u8BA4\u8BC1\u65B9\u5F0F", h("select", { "aria-label": "\u8BA4\u8BC1\u65B9\u5F0F", style: fieldStyle, value: provider, disabled: busy, onChange: (e) => {
            setProvider(e.target.value);
            setPreview(void 0);
          } }, h("option", { value: "otp" }, "\u90AE\u4EF6\u9A8C\u8BC1\u7801\uFF08One-time PIN\uFF09"), ...providers.filter((p) => p.type !== "onetimepin").map((p) => h("option", { key: p.id, value: p.id }, `${p.name || p.type} (${p.type})`)))),
          h(
            "details",
            { style: { marginTop: 16 } },
            h("summary", null, "\u8BBE\u5907\u9A8C\u8BC1\uFF08\u53EF\u9009\uFF09"),
            field("\u8BBE\u5907\u68C0\u67E5 ID", posture, setPosture),
            h("p", { style: { fontSize: 12, opacity: 0.75 } }, "\u9700\u5148\u5728 Zero Trust \u4E2D\u521B\u5EFA\u8BBE\u5907\u68C0\u67E5\u3002\u591A\u4E2A ID \u4EE5\u9017\u53F7\u5206\u9694\uFF0C\u5168\u90E8\u6EE1\u8DB3\u540E\u624D\u80FD\u8BBF\u95EE\u3002\u7559\u7A7A\u5219\u53EA\u9A8C\u8BC1\u8EAB\u4EFD\u3002")
          ),
          button("\u68C0\u67E5\u914D\u7F6E", async () => {
            const zone = zones.find((z) => z.id === zoneId);
            setPreview(await api("preview", { token, setup: { accountId: zone.accountId, zoneId, hostname, emails: emails.split(",").map((s) => s.trim()).filter(Boolean), identityProvider: provider, postureChecks: posture.split(",").map((s) => s.trim()).filter(Boolean) } }));
            setToken("");
            setConfirmation("");
          }, !zoneId || !token || !emails)
        )),
        preview && box(h(
          R.Fragment,
          null,
          h("h3", null, "\u53D1\u5E03\u786E\u8BA4"),
          h("p", null, `\u8BBF\u95EE\u5730\u5740\uFF1A${preview.setup.hostname}`),
          h("p", null, `\u5141\u8BB8\u90AE\u7BB1\uFF1A${preview.setup.emails.join(", ")}`),
          h("p", null, `\u5C06\u521B\u5EFA Access \u5E94\u7528\u3001\u8BBF\u95EE\u7B56\u7565\u3001Tunnel \u548C DNS \u8BB0\u5F55${preview.createOtp ? "\uFF0C\u5E76\u542F\u7528\u90AE\u4EF6\u9A8C\u8BC1\u7801\u767B\u5F55" : ""}\u3002`),
          h("p", null, "\u83B7\u51C6\u7528\u6237\u5171\u4EAB\u6B64 Harness \u7684\u6570\u636E\u548C\u5DE5\u5177\u6743\u9650\u3002\u4EC5\u5411\u53EF\u4FE1\u7BA1\u7406\u5458\u5F00\u653E\u3002"),
          h("p", { style: { fontSize: 12, opacity: 0.75 } }, "\u786E\u8BA4\u6709\u6548\u671F\uFF1A10 \u5206\u949F\u3002"),
          h("label", null, "\u8F93\u5165\u8BBF\u95EE\u5730\u5740\u4EE5\u786E\u8BA4", h("input", { style: fieldStyle, value: confirmation, disabled: busy, onChange: (e) => setConfirmation(e.target.value) })),
          button("\u53D1\u5E03", async () => {
            await api("provision", { planId: preview.planId, hostname: confirmation });
            setPreview(void 0);
            setNote("\u5DF2\u53D1\u5E03\uFF0C\u7B49\u5F85\u96A7\u9053\u8FDE\u63A5\u3002");
          }, confirmation !== preview.setup.hostname)
        )),
        d && box(h(
          R.Fragment,
          null,
          h("h3", null, "\u5220\u9664\u8BBF\u95EE\u914D\u7F6E"),
          h("p", null, "\u5220\u9664\u672C\u5B9E\u4F8B\u7BA1\u7406\u7684 DNS\u3001Tunnel \u548C Access \u5E94\u7528\uFF0C\u5171\u4EAB\u767B\u5F55\u65B9\u5F0F\u4FDD\u7559\u3002\u8BF7\u5148\u505C\u7528\u5E76\u586B\u5199 API Token\u3002"),
          button("\u5220\u9664\u914D\u7F6E\u2026", async () => {
            const confirmed = window.prompt(`\u5C06\u5220\u9664 ${d.hostname} \u7684\u8FDC\u7A0B\u8BBF\u95EE\u914D\u7F6E\u3002\u8F93\u5165\u5B8C\u6574\u57DF\u540D\u786E\u8BA4\uFF1A`);
            if (confirmed !== d.hostname) return;
            await api("cleanup", { token, hostname: confirmed });
            setToken("");
            setNote("\u8BBF\u95EE\u914D\u7F6E\u5DF2\u5220\u9664\u3002");
          }, !token || !!status.enabled)
        ))
      ),
      busy && h("p", { role: "status" }, "\u5904\u7406\u4E2D\u2026")
    );
  }
  return { name: "dsh-cloudflare-access-client", inject: [], apply(ctx) {
    if (!["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) ctx.inject(["connection"], (sub) => {
      sub.effect(() => installSessionRecovery(sub.connection), "cloudflare session recovery");
    });
    ctx.inject(["slots", "locale"], (sub) => {
      sub.effect(() => sub.locale.register("dsh-cloudflare-access", { zh: { nav: "Cloudflare \u96F6\u4FE1\u4EFB\u63A5\u5165" }, en: { nav: "Cloudflare Zero Trust" } }), "access locale");
      const t = sub.locale.bind("dsh-cloudflare-access");
      sub.slots.inject("settings.section", () => sub.slots.register({ name: "settings.section", id: "cloudflare", order: 25, label: () => t("nav"), locale: "dsh-cloudflare-access" }, () => h(Panel)));
    });
  } };
}

return module.exports.createClient(require);}});

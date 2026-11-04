// Shared helpers for the watch page and the results page.
(function () {
  const CFG = window.TRACKER_CONFIG;

  // localStorage with an in-memory fallback (some private/mobile modes block storage).
  const memory = new Map();
  const store = {
    get(key, fallback) {
      try {
        const v = localStorage.getItem(key);
        if (v !== null) return JSON.parse(v);
      } catch (e) { /* blocked */ }
      return memory.has(key) ? memory.get(key) : fallback;
    },
    set(key, value) {
      memory.set(key, value);
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* blocked */ }
    },
    remove(key) {
      memory.delete(key);
      try { localStorage.removeItem(key); } catch (e) { /* blocked */ }
    },
  };

  const configured = !!CFG.ENDPOINT_URL;

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec));
    const m = Math.floor(sec / 60), s = sec % 60;
    return m + ":" + String(s).padStart(2, "0");
  }

  // Talk to the Apps Script backend. Network problems throw an Error with .retry = true.
  async function api(method, params, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
    try {
      let res;
      if (method === "GET") {
        const qs = new URLSearchParams(Object.assign({}, params, { _: Date.now() }));
        const sep = CFG.ENDPOINT_URL.includes("?") ? "&" : "?";
        res = await fetch(CFG.ENDPOINT_URL + sep + qs, { signal: ctrl.signal });
      } else {
        // text/plain avoids a CORS preflight, which Apps Script can't answer.
        res = await fetch(CFG.ENDPOINT_URL, {
          method: "POST",
          headers: { "Content-Type": "text/plain;charset=utf-8" },
          body: JSON.stringify(params),
          signal: ctrl.signal,
        });
      }
      if (!res.ok) throw Object.assign(new Error("HTTP " + res.status), { retry: true });
      return await res.json();
    } catch (err) {
      if (err.retry === undefined) err.retry = true; // network error / timeout
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  window.TV = { CFG, store, configured, fmtTime, api };
})();

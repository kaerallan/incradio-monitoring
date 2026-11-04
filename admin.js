// Admin page: change the link, start a new round, review screenshots, export.
(function () {
  const { configured, api } = window.TV;
  const $ = id => document.getElementById(id);
  const PASS_KEY = "lp_admin_pass";
  const PAGE = 24;

  let pass = "";
  try { pass = sessionStorage.getItem(PASS_KEY) || ""; } catch (e) { /* blocked */ }
  let state = null;          // last "state" reply
  let rowsCache = {};        // round id -> rows
  let shown = PAGE;

  function notice(msg, kind) {
    $("notice").textContent = msg || "";
    $("notice").className = "banner " + (kind || "warn") + (msg ? "" : " hidden");
  }
  const fmt = iso => iso ? new Date(iso).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";

  async function call(op, extra, timeout) {
    const res = await api("POST", Object.assign({ action: "admin", pass, op }, extra || {}), timeout || 60000);
    if (!res.ok && (res.code === "auth" || res.code === "locked" || res.code === "nopass")) {
      signOut();
      notice(res.error);
      throw Object.assign(new Error(res.error), { handled: true });
    }
    return res;
  }

  // ---------- sign in ----------
  function signOut() {
    pass = "";
    try { sessionStorage.removeItem(PASS_KEY); } catch (e) { /* blocked */ }
    $("dash").classList.add("hidden");
    $("login").classList.remove("hidden");
  }
  $("logout").addEventListener("click", () => { signOut(); notice(""); });

  $("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    pass = $("pass").value;
    notice("");
    try {
      await loadState();
      try { sessionStorage.setItem(PASS_KEY, pass); } catch (err) { /* blocked */ }
      $("pass").value = "";
    } catch (err) {
      if (!err.handled) notice("Couldn't reach the server. Check your connection.");
    }
  });

  // ---------- state ----------
  async function loadState() {
    const res = await call("state");
    if (!res.ok) throw new Error(res.error);
    state = res;
    $("login").classList.add("hidden");
    $("dash").classList.remove("hidden");
    render();
  }

  function render() {
    const r = state.round;
    const counted = state.towns.reduce((s, t) => s + t.counted, 0);
    const rejected = state.towns.reduce((s, t) => s + t.rejected, 0);
    $("roundLine").textContent = (r.title || r.id) + " · " + counted + " counted.";
    $("curTitle").textContent = r.title || "(none)";
    $("curLink").textContent = r.link || "(not set: viewers can't send proofs yet)";
    $("curLink").href = r.link || "#";
    $("curStarted").textContent = fmt(r.started);
    $("curCounted").textContent = counted;
    $("curRejected").textContent = rejected;
    $("linkUrl").value = r.link || "";
    $("linkTitle").value = r.title || "";

    const dl = $("driveLinks");
    dl.innerHTML = "";
    const addLink = (href, text) => {
      if (!href) return;
      const a = document.createElement("a");
      a.href = href; a.target = "_blank"; a.rel = "noopener"; a.textContent = text;
      if (dl.childNodes.length) dl.appendChild(document.createTextNode(" · "));
      dl.appendChild(a);
    };
    addLink(state.folderUrl, "Screenshots folder in Drive");
    addLink(state.sheetUrl, "Google Sheet");
    if (dl.childNodes.length) dl.appendChild(document.createTextNode(" (owner's Google account only)"));

    const tb = $("townRows");
    tb.innerHTML = "";
    const sorted = state.towns.slice().sort((a, b) => b.counted - a.counted || a.town.localeCompare(b.town));
    for (const t of sorted) {
      const tr = document.createElement("tr");
      for (const [v, cls] of [[t.town, ""], [t.counted, "n"], [t.rejected, "n"]]) {
        const td = document.createElement("td");
        td.textContent = v; if (cls) td.className = cls;
        tr.appendChild(td);
      }
      tb.appendChild(tr);
    }

    for (const sel of [$("exportRound"), $("fRound")]) {
      const keep = sel.value;
      sel.innerHTML = "";
      for (const rd of state.rounds) {
        const o = document.createElement("option");
        o.value = rd.id;
        o.textContent = rd.id + " · " + (rd.title || "") + (rd.id === r.id ? " (current)" : "");
        sel.appendChild(o);
      }
      sel.value = state.rounds.some(x => x.id === keep) ? keep : r.id;
    }
    if ($("fTown").options.length === 1) {
      for (const t of state.towns.map(x => x.town).sort()) {
        const o = document.createElement("option");
        o.value = t; o.textContent = t;
        $("fTown").appendChild(o);
      }
    }
    loadProofs(false);
  }

  // ---------- link / round ----------
  $("linkForm").addEventListener("submit", async e => {
    e.preventDefault();
    await withButton($("saveLink"), async () => {
      const res = await call("setLink", { link: $("linkUrl").value, title: $("linkTitle").value });
      if (!res.ok) return notice(res.error);
      notice("Link saved. Counts were kept.", "ok");
      await loadState();
    });
  });

  $("newRound").addEventListener("click", async () => {
    if (!$("linkUrl").reportValidity()) return;
    const counted = state.towns.reduce((s, t) => s + t.counted, 0);
    const ok = confirm(
      "Start a new round?\n\n" +
      "Counts go back to 0 for everyone. The " + counted + " proofs from \"" + (state.round.title || state.round.id) +
      "\" stay saved, and you can still export them from the Export box.\n\n" +
      "Tip: download this round's export first.");
    if (!ok) return;
    await withButton($("newRound"), async () => {
      const res = await call("newRound", { link: $("linkUrl").value, title: $("linkTitle").value });
      if (!res.ok) return notice(res.error);
      notice("New round started: " + (res.round.title || res.round.id) + ". Counts are at 0.", "ok");
      rowsCache = {};
      await loadState();
    });
  });

  async function withButton(btn, fn) {
    btn.disabled = true;
    try { await fn(); }
    catch (err) { if (!err.handled) notice("Couldn't reach the server. Please try again."); }
    finally { btn.disabled = false; }
  }

  // ---------- rows + images ----------
  async function getRows(roundId, fresh) {
    if (!fresh && rowsCache[roundId]) return rowsCache[roundId];
    const res = await call("rows", { round: roundId }, 90000);
    if (!res.ok) throw new Error(res.error);
    rowsCache[roundId] = res.rows;
    return res.rows;
  }

  const images = new Map();   // proof id -> Promise<Blob>
  let active = 0;
  const waiting = [];
  function slot() {
    if (active < 4) { active++; return Promise.resolve(); }
    return new Promise(res => waiting.push(res));
  }
  function release() { active--; const next = waiting.shift(); if (next) { active++; next(); } }

  function getImage(id) {
    if (!images.has(id)) {
      const p = (async () => {
        await slot();
        try {
          let res;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { res = await call("image", { id }, 60000); if (res.ok) break; }
            catch (err) { if (err.handled || attempt === 2) throw err; }
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1)));
          }
          if (!res || !res.ok) throw new Error((res && res.error) || "image failed");
          const bin = atob(res.data);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          return new Blob([bytes], { type: res.mime || "image/jpeg" });
        } finally {
          release();
        }
      })();
      p.catch(() => images.delete(id));
      images.set(id, p);
    }
    return images.get(id);
  }

  const observer = "IntersectionObserver" in window ? new IntersectionObserver(entries => {
    for (const e of entries) if (e.isIntersecting) { observer.unobserve(e.target); fillShot(e.target); }
  }, { rootMargin: "300px" }) : null;

  async function fillShot(box) {
    try {
      const blob = await getImage(box.dataset.id);
      const img = document.createElement("img");
      img.alt = "Screenshot";
      img.src = URL.createObjectURL(blob);
      box.textContent = "";
      box.appendChild(img);
      box.onclick = () => window.open(img.src, "_blank");
    } catch (err) {
      box.textContent = "Couldn't load. Tap to retry.";
      box.onclick = () => { box.onclick = null; box.textContent = "Loading…"; fillShot(box); };
    }
  }

  ["fRound", "fTown", "fStatus"].forEach(id => $(id).addEventListener("change", () => { shown = PAGE; loadProofs(false); }));
  $("more").addEventListener("click", () => { shown += PAGE; loadProofs(false); });

  let loadSeq = 0;
  async function loadProofs(fresh) {
    const seq = ++loadSeq;
    const roundId = $("fRound").value || state.round.id;
    $("proofCount").textContent = "Loading…";
    let rows;
    try { rows = await getRows(roundId, fresh || roundId === state.round.id); }
    catch (err) { if (seq === loadSeq) $("proofCount").textContent = err.handled ? "" : "Couldn't load proofs."; return; }
    if (seq !== loadSeq) return;
    const town = $("fTown").value, status = $("fStatus").value;
    const list = rows.filter(r => (!town || r.town === town) && (!status || r.status === status))
      .sort((a, b) => b.time.localeCompare(a.time));
    $("proofCount").textContent = list.length + " proof" + (list.length === 1 ? "" : "s") + (list.length ? ", newest first" : "");
    const box = $("proofs");
    box.innerHTML = "";
    for (const r of list.slice(0, shown)) box.appendChild(proofCard(r, roundId));
    $("more").classList.toggle("hidden", list.length <= shown);
  }

  function proofCard(r, roundId) {
    const card = document.createElement("div");
    card.className = "proof" + (r.status === "rejected" ? " rejected" : "");
    const shot = document.createElement("div");
    shot.className = "shot";
    shot.dataset.id = r.id;
    shot.textContent = "Loading…";
    const info = document.createElement("div");
    info.className = "info";
    const t = document.createElement("span"); t.className = "t"; t.textContent = r.town;
    const w = document.createElement("span"); w.className = "when"; w.textContent = fmt(r.time);
    const b = document.createElement("span"); b.className = "badge"; b.textContent = r.status === "rejected" ? "Rejected" : "Counted";
    info.append(t, w, b);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = r.status === "rejected" ? "secondary" : "secondary danger";
    btn.textContent = r.status === "rejected" ? "Restore" : "Reject";
    btn.addEventListener("click", async () => {
      const to = r.status === "rejected" ? "counted" : "rejected";
      await withButton(btn, async () => {
        const res = await call("setStatus", { id: r.id, status: to });
        if (!res.ok) return notice(res.error);
        r.status = to;
        card.replaceWith(proofCard(r, roundId));
        notice("");
        if (roundId === state.round.id) {
          const s = await call("state");
          if (s.ok) { state = s; renderSummaryOnly(); }
        }
      });
    });
    card.append(shot, info, btn);
    if (observer) observer.observe(shot); else fillShot(shot);
    return card;
  }

  // Refresh the counts without reloading the review grid.
  function renderSummaryOnly() {
    const counted = state.towns.reduce((s, t) => s + t.counted, 0);
    const rejected = state.towns.reduce((s, t) => s + t.rejected, 0);
    $("roundLine").textContent = (state.round.title || state.round.id) + " · " + counted + " counted.";
    $("curCounted").textContent = counted;
    $("curRejected").textContent = rejected;
    const map = new Map(state.towns.map(t => [t.town, t]));
    for (const tr of $("townRows").children) {
      const t = map.get(tr.children[0].textContent);
      if (t) { tr.children[1].textContent = t.counted; tr.children[2].textContent = t.rejected; }
    }
  }

  // ---------- export ----------
  function csv(rows) {
    const cell = v => {
      let s = v == null ? "" : String(v);
      if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // stop spreadsheets running it as a formula
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    return "﻿" + rows.map(r => r.map(cell).join(",")).join("\r\n") + "\r\n";
  }
  const localTime = iso => {
    if (!iso) return "";
    const d = new Date(iso), p = n => String(n).padStart(2, "0");
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  };
  const safe = s => String(s).replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "");

  function statsCsv(round, rows) {
    const towns = state.towns.map(t => t.town);
    const c = {}, x = {};
    towns.forEach(t => { c[t] = 0; x[t] = 0; });
    rows.forEach(r => { if (!(r.town in c)) { c[r.town] = 0; x[r.town] = 0; } if (r.status === "rejected") x[r.town]++; else c[r.town]++; });
    const list = Object.keys(c).sort((a, b) => c[b] - c[a] || a.localeCompare(b));
    const out = [
      ["Round", round.id], ["Title", round.title], ["YouTube link", round.link],
      ["Started", localTime(round.started)], ["Ended", localTime(round.ended) || "(current)"], ["Exported", localTime(new Date().toISOString())],
      [],
      ["Locale", "Counted proofs", "Rejected"],
    ];
    list.forEach(t => out.push([t, c[t], x[t]]));
    out.push(["Total", list.reduce((s, t) => s + c[t], 0), list.reduce((s, t) => s + x[t], 0)]);
    return csv(out);
  }

  function download(blob, name) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
  }

  function selectedRound() {
    const id = $("exportRound").value || state.round.id;
    return state.rounds.find(r => r.id === id) || Object.assign({ ended: "" }, state.round);
  }
  const baseName = round => "proofs_" + safe(round.id + "_" + (round.title || ""));

  $("exportCsv").addEventListener("click", () => withButton($("exportCsv"), async () => {
    const round = selectedRound();
    const rows = await getRows(round.id, true);
    download(new Blob([statsCsv(round, rows)], { type: "text/csv" }), baseName(round) + "_stats.csv");
    $("exportStatus").textContent = "Downloaded stats for " + rows.length + " proofs.";
  }));

  $("exportZip").addEventListener("click", () => withButton($("exportZip"), async () => {
    if (!window.JSZip) { notice("The zip tool didn't load. Check your connection and refresh."); return; }
    const round = selectedRound();
    const st = $("exportStatus");
    st.textContent = "Getting the list…";
    const rows = await getRows(round.id, true);
    const zip = new JSZip();
    const list = [["Proof ID", "Time", "Locale", "Status", "Screenshot file", "Drive link", "Device (short)", "Reviewed"]];
    let done = 0, failed = 0;
    const sorted = rows.slice().sort((a, b) => a.time.localeCompare(b.time));
    await Promise.all(sorted.map(async r => {
      const path = "screenshots/" + safe(r.town) + "/" + safe(localTime(r.time).replace(" ", "_").replace(/:/g, "")) + "_" + r.id + ".jpg";
      try {
        const blob = await getImage(r.id);
        zip.file(path, blob);
        r._path = path;
      } catch (err) {
        if (err.handled) throw err;
        failed++;
        r._path = "(couldn't download, use the Drive link)";
      }
      done++;
      st.textContent = "Downloading screenshots… " + done + " / " + sorted.length;
    }));
    for (const r of sorted) {
      list.push([r.id, localTime(r.time), r.town, r.status, r._path,
        r.fileId ? "https://drive.google.com/file/d/" + r.fileId + "/view" : "", r.device, localTime(r.reviewed)]);
    }
    zip.file("stats.csv", statsCsv(round, rows));
    zip.file("proofs.csv", csv(list));
    st.textContent = "Making the zip file…";
    const blob = await zip.generateAsync({ type: "blob" });
    download(blob, baseName(round) + ".zip");
    st.textContent = "Downloaded " + sorted.length + " proofs" + (failed ? " (" + failed + " screenshots couldn't be downloaded; their Drive links are in proofs.csv)" : "") + ".";
  }));

  // ---------- start ----------
  $("loading").classList.add("hidden");
  if (!configured) {
    notice("This site isn't connected yet. Set ENDPOINT_URL in config.js.");
  } else if (pass) {
    loadState().catch(err => { if (!err.handled) { notice("Couldn't reach the server."); signOut(); } });
  } else {
    $("login").classList.remove("hidden");
  }
})();

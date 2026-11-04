// Proof page: pick a locale, like + comment on YouTube, send the screenshot.
(function () {
  const { CFG, store, configured, api } = window.TV;
  const K = { device: "lp_device_id", town: "lp_town", recent: "lp_recent_locales", sent: "lp_sent" };
  const RECENT_MAX = 3;
  const MAX_SHORT = 1080, MAX_LONG = 2560;   // keeps comment text readable, files small

  const $ = id => document.getElementById(id);
  const el = {
    title: $("title"), subtitle: $("subtitle"), notice: $("notice"), loading: $("loading"),
    stepTown: $("stepTown"), townForm: $("townForm"), townSelect: $("townSelect"), townContinue: $("townContinue"),
    recentWrap: $("recentWrap"), recentList: $("recentList"),
    stepProof: $("stepProof"), townName: $("townName"), changeTown: $("changeTown"),
    ytThumbLink: $("ytThumbLink"), ytThumb: $("ytThumb"), episodeTitle: $("episodeTitle"), ytLink: $("ytLink"),
    uploadCard: $("uploadCard"), fileInput: $("fileInput"), dropText: $("dropText"), preview: $("preview"),
    sendBtn: $("sendBtn"), status: $("status"),
    doneCard: $("doneCard"), doneText: $("doneText"), howTo: $("howTo"),
  };

  el.title.textContent = CFG.TITLE || "Like, comment, send your proof";
  el.subtitle.textContent = CFG.SUBTITLE || "";

  function notice(msg, kind) {
    el.notice.textContent = msg;
    el.notice.className = "banner " + (kind || "warn") + (msg ? "" : " hidden");
  }
  function setStatus(msg, kind) {
    el.status.textContent = msg;
    el.status.className = "status" + (kind ? " " + kind : "");
  }

  // Anonymous id: only used for "one proof per phone each week".
  let deviceId = store.get(K.device, null);
  if (!deviceId || !/^[\w-]{8,64}$/.test(deviceId)) {
    deviceId = crypto.randomUUID ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    store.set(K.device, deviceId);
  }

  let server = null;   // { round, towns }
  let town = "";
  let file = null;
  let sending = false;

  async function init() {
    if (!configured) {
      el.loading.classList.add("hidden");
      notice("This site isn't connected yet. The owner needs to set ENDPOINT_URL in config.js (see README).");
      return;
    }
    try {
      const res = await api("GET", { action: "config" });
      if (!res.ok) throw new Error(res.error || "config failed");
      server = res;
    } catch (err) {
      console.error(err);
      el.loading.textContent = "Something went wrong while loading. Check your connection and refresh the page.";
      return;
    }
    el.loading.classList.add("hidden");
    el.howTo.classList.remove("hidden");
    if (!server.round || !server.round.videoId) {
      notice("This week's video isn't up yet. Please check back soon.");
      return;
    }
    for (const t of server.towns) {
      const o = document.createElement("option");
      o.value = t; o.textContent = t;
      el.townSelect.appendChild(o);
    }
    const saved = store.get(K.town, "");
    if (server.towns.includes(saved)) el.townSelect.value = saved;
    renderRecent();
    refreshTownButton();

    const sent = store.get(K.sent, null);
    if (sent && sent.round === server.round.id && server.towns.includes(sent.town)) {
      town = sent.town;
      showProofStep();
      showDone(sent.town);
      checkMine();               // in case the admin rejected it, let them send a new one
    } else {
      el.stepTown.classList.remove("hidden");
    }
  }

  // ---------- recent locales ----------
  function getRecent() {
    let list = store.get(K.recent, null);
    if (!Array.isArray(list)) { const last = store.get(K.town, ""); list = last ? [last] : []; }
    return list.filter(t => server && server.towns.includes(t)).slice(0, RECENT_MAX);
  }
  function rememberRecent(t) {
    store.set(K.recent, [t].concat(getRecent().filter(x => x !== t)).slice(0, RECENT_MAX));
  }
  function renderRecent() {
    const list = getRecent();
    el.recentList.innerHTML = "";
    for (const t of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "chip";
      b.textContent = t;
      b.setAttribute("aria-label", "Send for " + t);
      b.addEventListener("click", () => {
        el.townSelect.value = t;
        refreshTownButton();
        el.townForm.requestSubmit ? el.townForm.requestSubmit() : el.townForm.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      el.recentList.appendChild(b);
    }
    el.recentWrap.classList.toggle("hidden", list.length === 0);
  }

  // ---------- locale picker ----------
  function refreshTownButton() { el.townContinue.disabled = !server || !server.towns.includes(el.townSelect.value); }
  el.townSelect.addEventListener("change", refreshTownButton);

  el.townForm.addEventListener("submit", e => {
    e.preventDefault();
    if (!server.towns.includes(el.townSelect.value)) return;
    town = el.townSelect.value;
    store.set(K.town, town);
    rememberRecent(town);
    renderRecent();
    el.stepTown.classList.add("hidden");
    showProofStep();
    checkMine();
  });

  el.changeTown.addEventListener("click", () => {
    if (sending) return;
    el.stepProof.classList.add("hidden");
    el.stepTown.classList.remove("hidden");
    el.townSelect.value = town;
    refreshTownButton();
  });

  function showProofStep() {
    const r = server.round;
    el.townName.textContent = town;
    el.episodeTitle.textContent = r.title || "This week's broadcast";
    el.ytLink.href = r.link;
    el.ytThumbLink.href = r.link;
    el.ytThumb.src = "https://i.ytimg.com/vi/" + encodeURIComponent(r.videoId) + "/hqdefault.jpg";
    el.stepProof.classList.remove("hidden");
  }

  function showDone(t) {
    el.uploadCard.classList.add("hidden");
    el.doneCard.classList.remove("hidden");
    el.changeTown.classList.add("hidden");
    el.doneText.textContent = "Proof sent for " + t + ". Thank you!";
  }
  function showUpload() {
    el.doneCard.classList.add("hidden");
    el.uploadCard.classList.remove("hidden");
    el.changeTown.classList.remove("hidden");
  }

  // Ask the server what this phone already sent this week.
  async function checkMine() {
    try {
      const res = await api("POST", { action: "mine", device: deviceId });
      if (!res.ok || res.round !== server.round.id) return;
      if (res.status === "counted") {
        store.set(K.sent, { round: res.round, town: res.town });
        town = res.town;
        el.townName.textContent = town;
        showDone(res.town);
      } else if (res.status === "rejected") {
        store.remove(K.sent);
        showUpload();
        notice("Your last screenshot wasn't accepted. Please send a new one that clearly shows your comment and your YouTube name.");
      }
    } catch (err) { /* offline: keep what we have */ }
  }

  // ---------- choosing the screenshot ----------
  el.fileInput.addEventListener("change", () => {
    const f = el.fileInput.files && el.fileInput.files[0];
    if (!f) return;
    if (f.type && !/^image\//.test(f.type)) {
      setStatus("That file isn't a picture. Please choose your screenshot.", "err");
      return;
    }
    file = f;
    if (el.preview.src) URL.revokeObjectURL(el.preview.src);
    el.preview.src = URL.createObjectURL(f);
    el.preview.classList.remove("hidden");
    el.dropText.textContent = "Tap to choose a different screenshot";
    el.sendBtn.disabled = false;
    setStatus("");
  });

  // Shrinks big screenshots so they upload fast on mobile data. Always sends a JPEG.
  async function prepare(f) {
    const url = URL.createObjectURL(f);
    try {
      const img = await new Promise((res, rej) => {
        const i = new Image();
        i.onload = () => res(i);
        i.onerror = () => rej(new Error("decode"));
        i.src = url;
      });
      const w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error("decode");
      const scale = Math.min(1, MAX_SHORT / Math.min(w, h), MAX_LONG / Math.max(w, h));
      const cw = Math.round(w * scale), ch = Math.round(h * scale);
      const c = document.createElement("canvas");
      c.width = cw; c.height = ch;
      const ctx = c.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, cw, ch);
      ctx.drawImage(img, 0, 0, cw, ch);
      let blob = null;
      for (const q of [0.85, 0.7, 0.55]) {
        blob = await new Promise(res => c.toBlob(res, "image/jpeg", q));
        if (blob && blob.size < 2.5 * 1024 * 1024) break;
      }
      if (!blob) throw new Error("encode");
      const b64 = await new Promise((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result).split(",")[1] || "");
        r.onerror = () => rej(new Error("read"));
        r.readAsDataURL(blob);
      });
      return { mime: "image/jpeg", data: b64 };
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  el.sendBtn.addEventListener("click", async () => {
    if (!file || sending) return;
    sending = true;
    el.sendBtn.disabled = true;
    el.fileInput.disabled = true;
    notice("");
    setStatus("Sending your proof…");
    try {
      let img;
      try { img = await prepare(file); } catch (err) {
        setStatus("We couldn't read that picture. Please send a screenshot (PNG or JPG).", "err");
        return;
      }
      let res;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          res = await api("POST", {
            action: "submit", round: server.round.id, town, device: deviceId,
            mime: img.mime, image: img.data, ua: navigator.userAgent,
          }, 60000);
          if (!(res && res.code === "busy")) break;
        } catch (err) {
          if (attempt === 2) throw err;
        }
        setStatus("Still sending…");
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
      }
      if (res && res.ok) {
        store.set(K.sent, { round: res.round, town: res.town });
        showDone(res.town);
        return;
      }
      const code = res && res.code;
      if (code === "already") {
        store.set(K.sent, { round: server.round.id, town: res.town || town });
        showDone(res.town || town);
        notice("This phone already sent a proof this week" + (res.town ? " (for " + res.town + ")" : "") + ".", "warn");
      } else if (code === "round") {
        setStatus("A new week has started. Refreshing the page…", "err");
        setTimeout(() => location.reload(), 2500);
      } else {
        setStatus((res && res.error) || "Something went wrong. Please try again.", "err");
      }
    } catch (err) {
      console.error(err);
      setStatus("We couldn't send it. Check your connection and try again.", "err");
    } finally {
      sending = false;
      el.fileInput.disabled = false;
      el.sendBtn.disabled = !file;
    }
  });

  init();
})();

// Results page: per-locale proof counts for the current week.
(function () {
  const { CFG, configured, api } = window.TV;
  const $ = id => document.getElementById(id);

  if (!configured) {
    $("notice").textContent = "This site isn't connected yet. The owner needs to set ENDPOINT_URL in config.js.";
    $("notice").classList.remove("hidden");
    $("rows").innerHTML = '<li class="empty">No data yet.</li>';
    return;
  }

  function render(data) {
    const towns = data.towns || [];
    const total = data.total || 0;
    const max = towns.reduce((m, t) => Math.max(m, t.count), 0);
    const withViews = towns.filter(t => t.count > 0);

    const r = data.round || {};
    $("rule").textContent = (r.title ? r.title + ". " : "") +
      "One screenshot proof of a like and comment counts for your locale.";
    $("kTotal").textContent = total.toLocaleString();
    $("kTowns").textContent = withViews.length + " / " + towns.length;
    $("kTop").textContent = withViews.length ? withViews[0].town : "None yet";
    $("kTop").title = $("kTop").textContent;

    const list = $("rows");
    list.innerHTML = "";
    if (!towns.length) list.innerHTML = '<li class="empty">No locales configured.</li>';
    for (const t of towns) {
      const li = document.createElement("li");
      li.className = "row";
      const pct = total ? Math.round(100 * t.count / total) : 0;
      li.innerHTML =
        '<div class="row-head"><span class="name"></span>' +
        '<span class="count"><span class="c"></span><span class="pct"></span></span></div>' +
        '<div class="track"><div class="fill"></div></div>';
      li.querySelector(".name").textContent = t.town;
      li.querySelector(".c").textContent = t.count.toLocaleString();
      li.querySelector(".pct").textContent = pct + "%";
      li.querySelector(".fill").style.width = (max ? 100 * t.count / max : 0) + "%";
      list.appendChild(li);
    }
    const when = data.updated ? new Date(data.updated) : new Date();
    $("updated").textContent = "Updated " + when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  async function load() {
    try {
      const data = await api("GET", { action: "stats" });
      if (!data.ok) throw new Error(data.error || "stats failed");
      render(data);
    } catch (err) {
      console.error(err);
      $("updated").innerHTML = '<span class="err">Couldn\'t get the latest numbers. Trying again soon.</span>';
    }
  }

  load();
  setInterval(load, Math.max(10, CFG.STATS_REFRESH_SECONDS || 30) * 1000);
})();

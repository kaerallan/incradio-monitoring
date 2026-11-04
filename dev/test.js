// Rule + abuse tests against the mock backend.
//   node dev/mock-server.js   (in another terminal)
//   node dev/test.js
const BASE = process.env.BASE || "http://localhost:8767";
const EXEC = BASE + "/exec";
const PASS = process.env.ADMIN_PASSCODE || "test-pass";
const crypto = require("crypto");

let failures = 0, passes = 0;
function check(name, cond, extra) {
  if (cond) { passes++; console.log("  ok   " + name); }
  else { failures++; console.log("  FAIL " + name + (extra ? "  -> " + JSON.stringify(extra) : "")); }
}
const get = async q => (await fetch(EXEC + "?" + new URLSearchParams(q))).json();
const post = async b => (await fetch(EXEC, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(b) })).json();
const admin = (op, extra) => post(Object.assign({ action: "admin", pass: PASS, op }, extra || {}));
const state = async () => (await fetch(BASE + "/__state")).json();

// A small valid-looking JPEG: correct magic bytes + random body (unique hash each time).
function jpeg(seed) {
  const body = seed
    ? Buffer.concat(Array.from({ length: 63 }, (_, i) => crypto.createHash("sha256").update(seed + ":" + i).digest())).subarray(0, 2000)
    : crypto.randomBytes(2000);
  return Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), body, Buffer.from([0xFF, 0xD9])]).toString("base64");
}
const dev = () => "dev-" + crypto.randomBytes(8).toString("hex");
const total = async () => (await get({ action: "stats" })).total;
const countOf = async t => ((await get({ action: "stats" })).towns.find(x => x.town === t) || {}).count;
const clear = () => fetch(BASE + "/__clearcache");

(async () => {
  console.log("Locale Proofs rule tests against " + BASE);

  // ---- before a link is set
  let cfg = await get({ action: "config" });
  check("config lists 34 locales", cfg.ok && cfg.towns.length === 34);
  const r1 = cfg.round.id;
  let res = await post({ action: "submit", round: r1, town: "Luna", device: dev(), mime: "image/jpeg", image: jpeg() });
  check("no proofs accepted before the admin sets a link", !res.ok && res.code === "nolink", res);

  // ---- admin auth
  res = await post({ action: "admin", pass: "wrong", op: "state" });
  check("wrong passcode refused", !res.ok && res.code === "auth", res);
  res = await post({ action: "admin", op: "state" });
  check("missing passcode refused", !res.ok && res.code === "auth", res);

  res = await admin("setLink", { link: "not a link", title: "x" });
  check("bad link refused", !res.ok, res);
  res = await admin("setLink", { link: "https://youtube.com/live/abcDEF12345?si=xyz", title: "INC Radio, Nov 8" });
  check("live link accepted and normalised", res.ok && res.round.videoId === "abcDEF12345" && res.round.link === "https://www.youtube.com/watch?v=abcDEF12345", res);
  cfg = await get({ action: "config" });
  check("viewers see the new link and title", cfg.round.videoId === "abcDEF12345" && cfg.round.title === "INC Radio, Nov 8");

  // ---- viewer submissions
  const A = dev();
  res = await post({ action: "submit", round: r1, town: "Luna", device: A, mime: "image/jpeg", image: jpeg("a1") });
  check("first proof counts", res.ok && res.town === "Luna", res);
  check("Luna shows 1", (await countOf("Luna")) === 1);

  res = await post({ action: "submit", round: r1, town: "Bangar", device: A, mime: "image/jpeg", image: jpeg() });
  check("second proof from the same phone refused", !res.ok && res.code === "already" && res.town === "Luna", res);

  res = await post({ action: "submit", round: r1, town: "Luna", device: dev(), mime: "image/jpeg", image: jpeg("a1") });
  check("same screenshot from another phone refused", !res.ok && res.code === "dupimage", res);

  res = await post({ action: "submit", round: r1, town: "Atlantis", device: dev(), mime: "image/jpeg", image: jpeg() });
  check("unknown locale refused", !res.ok, res);

  res = await post({ action: "submit", round: r1, town: "Luna", device: dev(), mime: "image/jpeg",
    image: Buffer.from("<html><script>alert(1)</script>" + "x".repeat(2000)).toString("base64") });
  check("non-image disguised as JPEG refused", !res.ok && res.code === "type", res);

  res = await post({ action: "submit", round: r1, town: "Luna", device: dev(), mime: "text/html", image: jpeg() });
  check("non-image type refused", !res.ok && res.code === "type", res);

  res = await post({ action: "submit", round: r1, town: "Luna", device: dev(), mime: "image/jpeg",
    image: Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF]), Buffer.alloc(4.5 * 1024 * 1024)]).toString("base64") });
  check("over-size picture refused", !res.ok && res.code === "size", res);

  res = await post({ action: "submit", round: "R999", town: "Luna", device: dev(), mime: "image/jpeg", image: jpeg() });
  check("wrong round refused", !res.ok && res.code === "round", res);

  res = await post({ action: "submit", round: r1, town: "Luna", device: "x", mime: "image/jpeg", image: jpeg() });
  check("missing device id refused", !res.ok, res);

  const B = dev(), C = dev();
  await post({ action: "submit", round: r1, town: "Bangar", device: B, mime: "image/jpeg", image: jpeg() });
  await post({ action: "submit", round: r1, town: "Bangar", device: C, mime: "image/jpeg", image: jpeg() });
  await clear();
  check("total is 3 after the refusals", (await total()) === 3);

  let s = await state();
  check("only accepted proofs left files in Drive (rest trashed or never saved)",
    s.files.filter(f => !f.trashed).length === 3, s.files);

  res = await post({ action: "mine", device: A });
  check("'mine' reports this phone's proof", res.ok && res.status === "counted" && res.town === "Luna", res);

  // ---- admin review
  const st = await admin("state");
  check("admin state has per-locale counted/rejected", st.ok && st.towns.find(t => t.town === "Bangar").counted === 2);
  const rows = (await admin("rows", { round: r1 })).rows;
  check("admin rows list all 3 proofs", rows.length === 3, rows);
  const lunaRow = rows.find(r => r.town === "Luna");
  res = await admin("image", { id: lunaRow.id });
  check("admin can fetch a screenshot", res.ok && res.mime === "image/jpeg" && Buffer.from(res.data, "base64")[0] === 0xFF, res.error);
  res = await admin("image", { id: "../../etc" });
  check("admin can't fetch files that aren't proofs", !res.ok, res);
  res = await post({ action: "admin", pass: "nope", op: "image", id: lunaRow.id });
  check("image needs the passcode", !res.ok && !res.data, res);

  res = await admin("setStatus", { id: lunaRow.id, status: "rejected" });
  check("reject works", res.ok, res);
  check("rejected proof leaves the count", (await countOf("Luna")) === 0 && (await total()) === 2);
  res = await post({ action: "mine", device: A });
  check("phone is told its proof was rejected", res.status === "rejected", res);

  res = await post({ action: "submit", round: r1, town: "Luna", device: A, mime: "image/jpeg", image: jpeg("a1") });
  check("rejected screenshot can't simply be re-sent", !res.ok && res.code === "dupimage", res);
  res = await post({ action: "submit", round: r1, town: "Luna", device: A, mime: "image/jpeg", image: jpeg("a2") });
  check("after a rejection the phone may send a new screenshot", res.ok, res);
  res = await admin("setStatus", { id: lunaRow.id, status: "counted" });
  check("restoring can't give one phone two counted proofs", !res.ok, res);
  check("Luna back at 1", (await countOf("Luna")) === 1);

  // ---- change link keeps counts
  res = await admin("setLink", { link: "https://www.youtube.com/watch?v=zzzzzzzzzzz", title: "INC Radio, Nov 8 (video)" });
  check("link change keeps the counts", res.ok && (await total()) === 3);
  res = await post({ action: "submit", round: r1, town: "Luna", device: A, mime: "image/jpeg", image: jpeg() });
  check("link change doesn't let a phone send again", !res.ok && res.code === "already", res);

  // ---- new round
  res = await admin("newRound", { link: "https://youtu.be/yyyyyyyyyyy", title: "INC Radio, Nov 15" });
  check("new round starts", res.ok && res.round.id !== r1, res);
  const r2 = res.round.id;
  check("counts are back at 0", (await total()) === 0);
  res = await post({ action: "submit", round: r1, town: "Luna", device: dev(), mime: "image/jpeg", image: jpeg() });
  check("old-round page is told to refresh", !res.ok && res.code === "round", res);
  res = await post({ action: "submit", round: r2, town: "Luna", device: A, mime: "image/jpeg", image: jpeg() });
  check("same phone can send again in the new round", res.ok, res);
  const old = (await admin("rows", { round: r1 })).rows;
  check("old round's proofs are still kept for export", old.length === 4 && old.filter(r => r.status !== "rejected").length === 3, old);
  const st2 = await admin("state");
  check("rounds list has both rounds with the old one ended", st2.rounds.length === 2 && st2.rounds[1].ended && !st2.rounds[0].ended, st2.rounds);

  // ---- lockout last (it blocks the admin for 10 minutes)
  for (let i = 0; i < 10; i++) await post({ action: "admin", pass: "guess" + i, op: "check" });
  res = await admin("check");
  check("passcode guessing is locked out after 10 tries, even for the right passcode", !res.ok && res.code === "locked", res);
  await clear();
  res = await admin("check");
  check("works again once the lockout expires", res.ok, res);

  console.log("\n" + passes + " passed, " + failures + " failed");
  process.exit(failures ? 1 : 0);
})().catch(err => { console.error(err); process.exit(2); });

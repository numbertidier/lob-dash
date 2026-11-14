// UI tests for FlowUI.mount in headless Chrome (CDP). Skipped when Chrome is not installed.
// Run: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { FlowSim } = require(path.join(__dirname, "..", "flow.js"));

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const HARNESS = pathToFileURL(path.join(__dirname, "ui_harness.html")).href;
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixture.json"), "utf8"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Venues as the newest engine reports them on the phone: Lighter blocked, KuCoin down (no proxy). */
const phoneVenues = (statusOf) => fixture.venues.map((v) => ({ name: v.name, kind: v.kind,
  status: v.name === "Lighter" ? "blocked" : v.name === "KuCoin" ? "down" : statusOf(v) }));
/** Engine state before the first trade: no rows at all (new engine: no rows before first trade). */
function emptyState() {
  return { now: fixture.seconds[0].t, coin: "BTC", px: 0, venues: phoneVenues(() => "connecting"),
    seconds: [], prints: [], walls: [], pushes: [], book: null, fuel: null, oi: null,
    usual: { vol1m: null, asOf: null, vol1mLive: null, coverage: null },
    health: { connected: 0, total: 18, blocked: 1, lagMs: 0, resumedAt: null, loopLagMs: 0, missed: {} } };
}
/** A live state in the newest engine shape: first row after a resume has gap: true, richer health. */
function liveState(i) {
  const st = new FlowSim(fixture).build(i);
  st.seconds = st.seconds.map((r, k) => (k === 0 ? { ...r, gap: true } : r));
  st.venues = phoneVenues(() => "live");
  st.health = { connected: 16, total: 18, blocked: 1, lagMs: 180, resumedAt: st.now - 120e3, loopLagMs: 9, missed: {} };
  return st;
}

async function openPage() {
  const prof = fs.mkdtempSync(path.join(os.tmpdir(), "flow-ui-test-"));
  const port = 9500 + Math.floor(Math.random() * 400);
  const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`,
    "--allow-file-access-from-files", "--window-size=390,844", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 60 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch { /* not up yet */ } }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0; const pending = new Map();
  ws.addEventListener("message", (m) => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); } });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const ev = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || r.result.exceptionDetails.text);
    return r.result.result.value;
  };
  await send("Page.enable");
  await send("Page.navigate", { url: HARNESS });
  for (let i = 0; i < 50; i++) { await sleep(100); if (await ev("!!window.ui").catch(() => false)) break; }
  const close = async () => { ws.close(); chrome.kill("SIGTERM"); await sleep(300); fs.rmSync(prof, { recursive: true, force: true }); };
  const emit = async (st) => { await ev(`window.src.emit(${JSON.stringify(st)})`); await sleep(150); };
  return { ev, emit, close };
}

const haveChrome = fs.existsSync(CHROME);

test("empty first state, then live rows: every card renders and nothing throws", { skip: !haveChrome && "no Chrome" }, async () => {
  const page = await openPage();
  try {
    await page.emit(emptyState());
    await page.emit(liveState(400));
    await page.emit(liveState(401));
    const out = await page.ev(`(() => { const q = (s) => document.querySelector(s); return {
      errors: window.errors,
      perp: q('[data-ref="mPerp"] .mkt-l1') ? q('[data-ref="mPerp"]').textContent : null,
      spot: q('[data-ref="mSpot"] .mkt-l1') ? q('[data-ref="mSpot"]').textContent : null,
      mread: q('[data-ref="mread"]').textContent,
      readout: q('[data-ref="netReadout"]').textContent,
      tapeRows: document.querySelectorAll('.pr').length,
      health: q('[data-ref="healthTxt"]').textContent,
      venMeta: q('[data-ref="venMeta"]').textContent,
      banner: q('[data-ref="banner"]').hidden ? null : q('[data-ref="banner"]').textContent }; })()`);
    assert.deepEqual(out.errors, []);
    assert.match(out.perp || "", /Perps/);
    assert.match(out.spot || "", /Spot/);
    assert.notEqual(out.mread, "Waiting for book updates.");
    assert.match(out.readout, /^Now/);
    assert.ok(out.tapeRows > 0);
    assert.equal(out.health, "16/18", "same live/total count as the engine and the Mac page");
    assert.match(out.venMeta, /16\/18 live/);
    assert.match(out.venMeta, /Lighter blocked/);
    assert.match(out.venMeta, /KuCoin off on phone/);
    assert.equal(out.banner, null, "KuCoin off and Lighter blocked are not a Partial banner");
  } finally { await page.close(); }
});

test("live, then a fresh engine (empty state), then live again renders cleanly", { skip: !haveChrome && "no Chrome" }, async () => {
  const page = await openPage();
  try {
    await page.emit(liveState(500));
    await page.emit(emptyState());
    await page.emit(liveState(300));
    const out = await page.ev(`({ errors: window.errors, perp: !!document.querySelector('[data-ref="mPerp"] .mkt-l1'),
      sk: document.querySelectorAll('.flow .sk').length })`);
    assert.deepEqual(out.errors, []);
    assert.ok(out.perp);
    assert.equal(out.sk, 0, "no skeleton left behind");
  } finally { await page.close(); }
});

test("a venue still connecting shows as connecting, not as a down banner", { skip: !haveChrome && "no Chrome" }, async () => {
  const page = await openPage();
  try {
    const st = liveState(400);
    st.venues = st.venues.map((v) => (v.name === "Pacifica" ? { ...v, status: "connecting" } : v));
    await page.emit(st);
    const out = await page.ev(`({ errors: window.errors, banner: document.querySelector('[data-ref="banner"]').hidden ? null : document.querySelector('[data-ref="banner"]').textContent })`);
    assert.deepEqual(out.errors, []);
    assert.ok(!out.banner || !/down/.test(out.banner), `banner: ${out.banner}`);
  } finally { await page.close(); }
});

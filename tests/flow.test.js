// Node tests for the pure parts of flow.js: node --test tests/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");
const { FlowDerive, FlowLife, FlowSim } = require(path.join(__dirname, "..", "flow.js"));

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixture.json"), "utf8"));

/** A fake engine with the engine surface and counters for start/stop. */
function fakeEngine() {
  const subs = new Set();
  return { started: 0, stopped: 0, subs,
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    start() { this.started++; }, stop() { this.stopped++; },
    emit(st) { for (const fn of subs) fn(st); } };
}
/** Manual clock: timers fire only on advance(). */
function fakeClock() {
  let now = 0, id = 0; const timers = new Map();
  return { now: () => now,
    setTimeout(f, ms) { timers.set(++id, { f, at: now + ms }); return id; },
    clearTimeout(t) { timers.delete(t); },
    advance(ms) { now += ms; for (const [k, t] of [...timers]) if (t.at <= now) { timers.delete(k); t.f(); } },
    jump(ms) { now += ms; },   // wall clock moves but timers do not fire (iOS background)
    pending: () => timers.size };
}
function lifeWith(clock) {
  const made = [];
  const life = new FlowLife({ makeEngine: () => { const e = fakeEngine(); made.push(e); return e; }, clock, graceMs: 60_000 });
  return { life, made };
}

test("engine does not start until the tab is shown", () => {
  const { life, made } = lifeWith(fakeClock());
  life.setPage(true);
  assert.equal(made.length, 0);
  life.setTab(true);
  assert.equal(made.length, 1);
  assert.equal(made[0].started, 1);
});

test("states are forwarded only while active", () => {
  const { life, made } = lifeWith(fakeClock());
  const got = [];
  life.subscribe((s) => got.push(s));
  life.setTab(true);
  made[0].emit({ n: 1 });
  life.setTab(false);
  made[0].emit({ n: 2 });
  assert.deepEqual(got.map((s) => s.n), [1]);
  life.setTab(true);   // back inside the grace period: same engine, latest state replayed at once
  assert.equal(made.length, 1);
  assert.deepEqual(got.map((s) => s.n), [1, 2]);
});

test("hidden for more than 60 s stops the engine; return starts a fresh one", () => {
  const clock = fakeClock();
  const { life, made } = lifeWith(clock);
  life.setTab(true);
  life.setPage(false);
  clock.advance(59_000);
  assert.equal(made[0].stopped, 0);
  clock.advance(2_000);
  assert.equal(made[0].stopped, 1);
  assert.equal(made[0].subs.size, 0);
  life.setPage(true);
  assert.equal(made.length, 2);
  assert.equal(made[1].started, 1);
});

test("hidden under 60 s keeps the same engine", () => {
  const clock = fakeClock();
  const { life, made } = lifeWith(clock);
  life.setTab(true);
  life.setTab(false);
  clock.advance(30_000);
  life.setTab(true);
  clock.advance(120_000);
  assert.equal(made.length, 1);
  assert.equal(made[0].stopped, 0);
  assert.equal(clock.pending(), 0);
});

test("frozen background timers: wall clock over 60 s still restarts on return", () => {
  const clock = fakeClock();
  const { life, made } = lifeWith(clock);
  life.setTab(true);
  life.setPage(false);
  clock.jump(5 * 60_000);   // timer never fired
  life.setPage(true);
  assert.equal(made[0].stopped, 1);
  assert.equal(made.length, 2);
});

test("leaving the tab while the page is hidden does not double-arm the timer", () => {
  const clock = fakeClock();
  const { life, made } = lifeWith(clock);
  life.setTab(true);
  life.setPage(false);
  life.setTab(false);
  assert.equal(clock.pending(), 1);
  clock.advance(61_000);
  assert.equal(made[0].stopped, 1);
  life.setPage(true);
  assert.equal(made.length, 1, "tab still hidden: nothing starts");
});

test("markOff turns a down KuCoin into off and leaves other venues alone", () => {
  const st = { venues: [{ name: "Binance", status: "down" }, { name: "KuCoin", status: "down" }, { name: "Lighter", status: "blocked" }, { name: "OKX", status: "live" }] };
  const out = FlowDerive.markOff(st, ["KuCoin"]);
  assert.deepEqual(out.venues.map((v) => v.status), ["down", "off", "blocked", "live"]);
  assert.equal(st.venues[1].status, "down", "input not mutated");
  assert.equal(FlowDerive.markOff(st, []), st);
  const hc = FlowDerive.healthCount(out);
  assert.deepEqual(hc, { live: 1, total: 4, notes: ["Lighter blocked", "KuCoin off on phone"] });
});

test("ladder keeps a fixed grid of 2n+1 rows and flags crossed rows", () => {
  const st = { px: 100_000, book: { rows: [
    { px: 99_990, bid: 5e6, ask: 0 }, { px: 99_980, bid: 2e6, ask: 0 },
    { px: 100_010, bid: 0, ask: 4e6 }, { px: 100_020, bid: 0, ask: 1e6 },
    { px: 100_000, bid: 1e6, ask: 1e6 } ] } };
  const L = FlowDerive.ladder(st, 10, 5);
  assert.equal(L.rows.length, 11);
  const steps = L.rows.slice(1).map((r, i) => L.rows[i].px - r.px);
  assert.ok(steps.every((d) => d === 10));
  assert.equal(L.rows.filter((r) => r.kind === "crossed").length, 1);
  const total = L.rows.reduce((a, r) => a + r.bid + r.ask, 0);
  assert.equal(total, 14e6, "nothing dropped inside the grid");
});

test("fixture replay: last minute sums match the raw seconds", () => {
  const sim = new FlowSim(fixture, { start: 600 });
  const st = sim.build(600);
  const lm = FlowDerive.lastMinute(st);
  const last60 = st.seconds.slice(-60);
  const buy = last60.reduce((a, r) => a + r.perpBuy, 0);
  assert.ok(Math.abs(lm.perpBuy - buy) < 1e-6 * Math.max(1, buy));
  const sizeBuy = lm.size.small[0] + lm.size.mid[0] + lm.size.large[0];
  assert.ok(Math.abs(sizeBuy - lm.perpBuy) / lm.perpBuy < 1e-5, "order-size mix adds up to perp buys (fixture rounding)");
});

test("fixture replay: venue minute volumes add up to the all-venue minute", () => {
  const st = new FlowSim(fixture).build(700);
  const vs = FlowDerive.venues(st);
  const sum = vs.reduce((a, v) => a + v.vol, 0);
  const all = st.seconds.slice(-60).reduce((a, r) => a + r.perpBuy + r.perpSell + r.spotBuy + r.spotSell, 0);
  assert.ok(Math.abs(sum - all) / all < 1e-5, "fixture values are rounded per field");
  assert.equal(vs.length, st.venues.length);
});

test("netSeries ends at the window's cumulative net", () => {
  const st = new FlowSim(fixture).build(900);
  const s = FlowDerive.netSeries(st, 300e3);
  const rows = st.seconds.filter((r) => r.t >= s.t[0]);
  const net = rows.reduce((a, r) => a + r.perpBuy - r.perpSell, 0);
  assert.ok(Math.abs(s.perp[s.n - 1] - net) < 1e-6 * Math.max(1, Math.abs(net)));
});

test("seconds with px 0 at engine start do not break price change or the price lane", () => {
  const st = new FlowSim(fixture).build(400);
  const seconds = st.seconds.map((r, i) => (i < 3 ? { ...r, px: 0 } : r));
  const s2 = { ...st, seconds };
  const ws = FlowDerive.windowStats(s2, 1200e3);
  assert.ok(Number.isFinite(ws.pxChg));
  assert.equal(ws.pxChg, (st.px / seconds[3].px - 1) * 100);
  const ns = FlowDerive.netSeries(s2, 1200e3);
  assert.ok(Array.from(ns.px).every((v) => v > 0));
});

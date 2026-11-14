/**
 * flow.js: the Flow tab (live BTC order flow) for the LOB phone app.
 * Lifted from flow_build/design_mobile/flow_mobile.html. Numbers, words and colours come from flow-shared.js.
 *
 *   FlowDerive  pure: lastMinute, read, netSeries, windowStats, venues, fuelNear, ladder (node-testable)
 *   FlowSim     fixture replay with the engine surface (?sim=1 demos only)
 *   FlowLife    lifecycle: start the engine when the tab opens, stop it after 60 s hidden, fresh engine on return
 *   FlowUI      mount(root, source, opts) -> { setTheme, setActive, destroy, jump, openExplain, venueSheet }
 *
 * Browser: load flow-shared.js first; this file sets window.FlowDerive, FlowSim, FlowLife, FlowUI.
 * Node: const { FlowDerive, FlowLife } = require("./flow.js").
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./flow-shared.js"));
  else Object.assign(root, factory(root.FlowShared));
})(typeof self !== "undefined" ? self : this, function (FlowShared) {
  "use strict";

  /* =====================================================================
     1. Fmt: number and time formatting (thin layer over the shared module).
     ===================================================================== */
  const S = FlowShared.Fmt;
  const Fmt = {
    MINUS: S.MINUS,
    usd: (x) => S.usd(x),                       // $8.77M, 3 significant figures
    sUsd: (x) => S.usd(x, { sign: true }),      // +$8.77M
    px: (x, dp = 1) => S.px(x, dp),
    pct: (x, dp = 2) => S.pct(x, dp),
    mult: (x) => S.times(x),                    // 5.84×
    z: (x) => S.z(x),
    time: (ms) => S.hms(ms),
    hm: (ms) => S.hm(ms),
    ago: (ms, now) => `${S.age(now - ms)} ago`,
  };

  /* =====================================================================
     2. FlowDerive: every number the UI shows, computed from FlowState. Pure.
     ===================================================================== */
  const FlowDerive = (() => {
    const D = FlowShared.Derive, R = D.RULES;
    const tail = (arr, n) => arr.slice(Math.max(0, arr.length - n));
    const share = (b, s) => (b + s > 0 ? b / (b + s) : null);
    /** First index with arr[i].t >= t0 (arr sorted by t). */
    function lowerBound(arr, t0) {
      let lo = 0, hi = arr.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < t0) lo = mid + 1; else hi = mid; }
      return lo;
    }

    /** Taker flow, last minute (shared), plus the phone's order-size mix (bySize, perps only). */
    function lastMinute(st) {
      const f = D.taker1m(st), size = { small: [0, 0], mid: [0, 0], large: [0, 0] };
      for (const r of tail(st.seconds, R.FLOW_SEC)) for (const k in size) { size[k][0] += r.bySize[k][0]; size[k][1] += r.bySize[k][1]; }
      return { n: f.haveSec, perpBuy: f.perp.buy, perpSell: f.perp.sell, spotBuy: f.spot.buy, spotSell: f.spot.sell, size,
               xUsual: f.xUsual, heat: f.hot ? "hot" : f.quiet ? "quiet" : f.xUsual == null ? "unknown" : "normal",
               perpShare: f.perp.buyShare, spotShare: f.spot.buyShare };
    }
    /** The read (shared): verdict, label (lean when quiet), sentence parts. */
    const read = (st) => D.read(st, { oi: "include" });
    /** Makers, 10 s (shared). */
    const makers = (st) => D.makers10s(st);

    /** Net series (shared) plus price per second for the price lane. */
    function netSeries(st, winMs) {
      const s = D.netSeries(st, winMs), n = s.t.length, px = new Float64Array(n);
      for (let i = 0; i < n; i++) px[i] = st.seconds[s.i0 + i].px;
      // The engine's first seconds can carry px 0 (no trade yet): fill them from the first real price.
      const k = px.findIndex((v) => v > 0);
      for (let i = 0; i < k; i++) px[i] = px[k];
      return { from: s.t0, to: s.t1, n, t: s.t, px, perp: s.perp, spot: s.spot };
    }
    /** Window stats (shared) plus the price change over the window. */
    function windowStats(st, winMs) {
      const w = D.windowStats(st, winMs), first = st.seconds.slice(w.i0).find((r) => r.px > 0);   // skip px 0 seconds
      return { bought: w.perpBought, sold: w.perpSold, biggest: w.biggest, big: w.prints1m, prints: w.prints,
               sweeps: w.sweeps, pushes: w.pushes, pxChg: first && st.px > 0 ? (st.px / first.px - 1) * 100 : null };
    }

    /** Per-venue last minute plus 30 ten-second net buckets for the sparkline. */
    function venues(st) {
      const rows = tail(st.seconds, 300), last = rows.length - 60;
      const total = rows.slice(Math.max(0, last)).reduce((a, r) => a + r.perpBuy + r.perpSell + r.spotBuy + r.spotSell, 0);
      return st.venues.map((v) => {
        let buy = 0, sell = 0;
        const spark = new Float64Array(30);
        rows.forEach((r, i) => {
          const bs = r.byVenue[v.name]; if (!bs) return;
          if (i >= last) { buy += bs[0]; sell += bs[1]; }
          spark[Math.min(29, Math.floor((i + (300 - rows.length)) / 10))] += bs[0] - bs[1];
        });
        return { ...v, buy, sell, vol: buy + sell, share: share(buy, sell), ofTotal: total ? (buy + sell) / total : 0, spark };
      });
    }

    /** Nearest fuel each side (shared) plus $ within 2% of price. */
    function fuelNear(st) {
      if (!st.fuel) return null;
      const n = D.nearestFuel(st.fuel, st.px);
      const within = (side) => st.fuel.levels.filter((l) => (side > 0 ? l.px > st.px : l.px < st.px) && Math.abs(l.px / st.px - 1) <= 0.02).reduce((a, l) => a + l.usd, 0);
      return { above: n.above, below: n.below, up2: within(1), dn2: within(-1) };
    }

    /** Ladder on a fixed price grid, 2n+1 rows centred on the book's own middle. Nothing is dropped:
     *  a row holding both bids and asks is "crossed" (venues out of step) and drawn muted. */
    function ladder(st, step, n) {
      if (!st.book) return null;
      const lv = new Map(), get = (k) => lv.get(k) || (lv.set(k, { bid: 0, ask: 0 }), lv.get(k));
      let nearBid = 0, nearAsk = 0;
      for (const r of st.book.rows) {
        if (r.bid > 0) get(Math.floor(r.px / step) * step).bid += r.bid;
        if (r.ask > 0) get(Math.ceil(r.px / step) * step).ask += r.ask;
        if (Math.abs(r.px / st.px - 1) <= 0.002) { nearBid += r.bid; nearAsk += r.ask; }
      }
      let bestBid = -Infinity, bestAsk = Infinity;
      for (const [k, e] of lv) { if (e.bid > 0) bestBid = Math.max(bestBid, k); if (e.ask > 0) bestAsk = Math.min(bestAsk, k); }
      const centre = Math.round(((Number.isFinite(bestBid) ? bestBid : st.px) + (Number.isFinite(bestAsk) ? bestAsk : st.px)) / 2 / step) * step;
      const rows = [];
      let crossedUsd = 0;
      for (let k = n; k >= -n; k--) {
        const px = centre + k * step, e = lv.get(px) || { bid: 0, ask: 0 };
        const kind = e.bid > 0 && e.ask > 0 ? "crossed" : e.ask > 0 ? "ask" : e.bid > 0 ? "bid" : "empty";
        if (kind === "crossed") crossedUsd += e.bid + e.ask;
        rows.push({ px, bid: e.bid, ask: e.ask, kind });
      }
      const top = (kind, f) => new Set(rows.filter((r) => r.kind === kind).sort((a, b) => f(b) - f(a)).slice(0, 3).map((r) => r.px));
      return { rows, step, top: centre + n * step, topAsk: top("ask", (r) => r.ask), topBid: top("bid", (r) => r.bid),
               crossed: bestAsk <= bestBid, crossedUsd, nearBid, nearAsk };
    }

    /** Venues we cannot reach from this client show as "off" instead of "down" (KuCoin on the phone: no proxy). */
    function markOff(st, names) {
      if (!names || !names.length || !st.venues.some((v) => names.includes(v.name) && v.status === "down")) return st;
      return { ...st, venues: st.venues.map((v) => (names.includes(v.name) && v.status === "down" ? { ...v, status: "off" } : v)) };
    }
    /** Live venues over all venues (18), the same count as the engine's health and the Mac page.
     *  notes: the venues we never reach, said in words ("Lighter blocked", "KuCoin off on phone"). */
    function healthCount(st) {
      const notes = st.venues.filter((v) => v.status === "blocked").map((v) => `${v.name} blocked`)
        .concat(st.venues.filter((v) => v.status === "off").map((v) => `${v.name} off on phone`));
      return { live: st.venues.filter((v) => v.status === "live").length, total: st.venues.length, notes };
    }

    return { BIG: R.BIG_USD, RULES: R, lastMinute, read, makers, netSeries, windowStats, venues, fuelNear, ladder, markOff, healthCount,
             events: (st, filter, limit) => D.events(st, { filter, limit }), clusters: (prints) => D.clusterPrints(prints),
             alerts: (st) => D.alerts(st), health: (st) => D.venueHealth(st), lowerBound };
  })();

  /* =====================================================================
     3. FlowSim: replays the recorded fixture as a FlowState stream (?sim=1).
        Same surface as the engine: subscribe(fn) -> unsubscribe, state(), start(), stop().
        Book is the final recorded snapshot, re-centred on the replayed price with light noise.
        Fuel and OI are the recorded snapshots.
     ===================================================================== */
  class FlowSim {
    /**
     * @param {object} fixture FlowState recorded at the end of a 20 minute run.
     * @param {{start?: number, speed?: number}} opts start = seconds of history at launch.
     */
    constructor(fixture, opts = {}) {
      this.fx = fixture;
      this.speed = opts.speed || 1;
      this.i = Math.min(fixture.seconds.length, Math.max(60, opts.start ?? 790));
      this.subs = new Set();
      this.current = null;
      this.timer = null;
    }
    /** Register a listener; returns an unsubscribe function. */
    subscribe(fn) { this.subs.add(fn); return () => this.subs.delete(fn); }
    /** Latest FlowState, or null before the first tick. */
    state() { return this.current; }
    /** Emit now, then once a second (scaled by speed). */
    start() { this.emit(); this.timer = setInterval(() => this.step(), 1000 / this.speed); }
    /** Stop emitting. */
    stop() { clearInterval(this.timer); this.timer = null; }
    /** Socket stats: none for a replay. */
    stats() { return { feeds: {}, counters: {} }; }
    step() { this.i = this.i >= this.fx.seconds.length ? 300 : this.i + 1; this.emit(); }   // loop, keeping 5m of history
    emit() { this.current = this.build(this.i); for (const fn of this.subs) fn(this.current); }
    build(i) {
      const fx = this.fx, seconds = fx.seconds.slice(0, i), last = seconds[seconds.length - 1], now = last.t + 1000;
      const prints = fx.prints.slice(0, FlowDerive.lowerBound(fx.prints, now));
      return {
        now, coin: "BTC", px: last.px, venues: fx.venues.map((v) => ({ ...v })),
        seconds: seconds.slice(-1200),
        prints: prints.slice(FlowDerive.lowerBound(prints, now - 1200e3)),
        walls: fx.walls.filter((w) => w.t < now && w.t >= now - 2400e3),
        pushes: fx.pushes.filter((p) => p.t < now && p.t >= now - 2400e3),
        book: this.book(last.px, now),
        fuel: fx.fuel ? { ...fx.fuel, at: now - 4000 } : null,
        oi: fx.oi ? { ...fx.oi, at: now - 4000, d1hPct: i >= 1200 ? fx.oi.d1hPct : null } : null,
        usual: { vol1m: fx.usual.vol1m, asOf: now - 60000 },
        health: { connected: 17, total: fx.venues.length, lagMs: 140 + ((i * 37) % 120) },
      };
    }
    /** Recorded ladder shifted to the replayed price, with small deterministic noise. */
    book(px, now) {
      const b = this.fx.book; if (!b) return null;
      const shift = Math.round((px - this.fx.px) / b.step) * b.step, s = now / 1000;
      return { at: now - 700, step: b.step, rows: b.rows.map((r, k) => {
        const n = 1 + 0.18 * Math.sin(k * 1.7 + s * 0.9) * Math.sin(k * 0.31 + s * 0.23);
        return { px: Math.round((r.px + shift) * 100) / 100, bid: r.bid * n, ask: r.ask * n };
      }) };
    }
  }

  /* =====================================================================
     4. FlowLife: when the engine runs. The UI subscribes once to this relay.
        Runs only while the Flow tab is shown and the page is visible. After graceMs hidden it stops
        (sockets closed, timers cleared) and is dropped. On return a fresh engine starts: the engine
        zero-fills seconds it missed, so reusing it would show the pause as zero flow.
        While hidden but inside the grace period, states are kept but not forwarded (no rendering).
     ===================================================================== */
  class FlowLife {
    /**
     * @param {{makeEngine: () => object, graceMs?: number, clock?: {now: Function, setTimeout: Function, clearTimeout: Function}}} o
     */
    constructor({ makeEngine, graceMs = 60_000, clock = null }) {
      this.makeEngine = makeEngine;
      this.graceMs = graceMs;
      this.clock = clock || { now: () => Date.now(), setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (t) => clearTimeout(t) };
      this.listeners = new Set();
      this.engine = null; this.unsub = null; this.latest = null;
      this.tabShown = false; this.pageShown = true;
      this.hiddenAt = null; this.timer = null; this.starts = 0;
    }
    /** @param {(state: object) => void} fn @returns {() => void} unsubscribe */
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
    /** True while states are forwarded to the UI. */
    get active() { return this.tabShown && this.pageShown; }
    /** @param {boolean} on whether the Flow tab is the selected tab */
    setTab(on) { this.tabShown = !!on; this.update(); }
    /** @param {boolean} on whether the page is visible (document.visibilityState) */
    setPage(on) { this.pageShown = !!on; this.update(); }
    /** Socket stats of the running engine, or null. */
    stats() { return this.engine && this.engine.stats ? this.engine.stats() : null; }

    update() {
      if (!this.active) {
        if (this.engine && this.hiddenAt === null) {
          this.hiddenAt = this.clock.now();
          this.timer = this.clock.setTimeout(() => this.pause(), this.graceMs);
        }
        return;
      }
      if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
      // iOS freezes timers in the background, so also check the wall clock on return.
      if (this.engine && this.hiddenAt !== null && this.clock.now() - this.hiddenAt > this.graceMs) this.pause();
      this.hiddenAt = null;
      if (!this.engine) this.resume();
      else if (this.latest) this.forward(this.latest);
    }
    resume() {
      this.engine = this.makeEngine();
      this.starts++;
      this.unsub = this.engine.subscribe((st) => { this.latest = st; if (this.active) this.forward(st); });
      this.engine.start();
    }
    /** Stop the engine and drop it (closes every socket). */
    pause() {
      if (this.timer !== null) { this.clock.clearTimeout(this.timer); this.timer = null; }
      if (!this.engine) return;
      this.unsub(); this.engine.stop();
      this.engine = null; this.unsub = null; this.latest = null;
    }
    forward(st) { for (const fn of this.listeners) fn(st); }
  }

  /* =====================================================================
     5. FlowUI: the render module. Reads FlowState only (via source.subscribe). No fetches, no exchange logic.
     ===================================================================== */
  const TEMPLATE = `
<div class="fstrip">
  <span class="f-live off" data-ref="live">◌ …</span><span class="ttl">BTC order flow</span>
  <span class="spacer"></span>
  <button class="hbtn" data-ref="healthBtn" aria-label="Venue health"><span class="dot" data-ref="healthDot"></span><span data-ref="healthTxt">–</span></button>
</div>
<div class="banner" data-ref="banner" role="status" hidden><b data-ref="bannerK"></b><span data-ref="bannerT"></span></div>
<div class="fmain">
  <section class="card hero" id="sec-read" data-ref="hero" aria-live="polite">
    <div class="hero-top">
      <span class="sym">BTC</span>
      <span class="px live-num" data-ref="px">–</span>
      <span class="chg"><span data-ref="chg" class="live-num">–</span><span class="sub" data-ref="chgW">in 20m</span></span>
    </div>
    <div class="verdict-row">
      <span class="verdict even" data-ref="verdict"><span data-ref="vGlyph">◆</span><span data-ref="vText">Waiting</span></span>
      <span class="heat" data-ref="heat">–</span>
      <button class="q" data-explain="read" aria-label="Explain the read"></button>
    </div>
    <p class="read" data-ref="readText">Connecting to venues.</p>
  </section>
  <section class="card" id="sec-minute">
    <div class="hd"><h2>Taker flow · last min</h2><span class="meta" data-ref="minMeta"></span><button class="q" data-explain="minute" aria-label="Explain taker flow"></button></div>
    <div class="bd">
      <div class="xrow">
        <span class="xval live-num"><span data-ref="xVal">–</span><small>usual</small></span>
        <div class="gauge" data-ref="gauge" aria-hidden="true">
          <div class="track"></div><div class="fill" data-ref="gFill" style="width:0"></div>
          <div class="tick" style="left:25%"><span>1×</span></div><div class="tick" style="left:50%"><span>2×</span></div><div class="tick" style="left:100%;margin-left:-1px"><span>4×</span></div><span class="over" data-ref="gOver" hidden></span>
        </div>
      </div>
      <div class="mkt" data-ref="mPerp"></div>
      <div class="mkt" data-ref="mSpot"></div>
      <button class="sizes-btn" data-ref="sizesBtn" aria-expanded="false">By order size</button>
      <div class="sizes" data-ref="sizes" hidden></div>
    </div>
  </section>
  <section class="card" id="sec-makers">
    <div class="hd"><h2>Makers · last 10s</h2><span class="meta">Binance top 20 levels</span><button class="q" data-explain="makers" aria-label="Explain makers"></button></div>
    <div class="bd">
      <div class="mscale" aria-hidden="true"><span></span><span><span>◀ pulled</span><span>added ▶</span></span><span></span></div>
      <div class="mrow"><b>Bids</b><div class="mbar"><span class="zero"></span><i class="neg" data-ref="bidNeg"></i><i class="pos" data-ref="bidPos"></i></div><span class="mval live-num" data-ref="bidVal">–</span></div>
      <div class="mrow"><b>Asks</b><div class="mbar"><span class="zero"></span><i class="neg" data-ref="askNeg"></i><i class="pos" data-ref="askPos"></i></div><span class="mval live-num" data-ref="askVal">–</span></div>
      <p class="mread" data-ref="mread"></p>
    </div>
  </section>
  <section class="card" id="sec-net">
    <div class="hd"><h2 data-ref="netTitle">Net flow · since 20m</h2><button class="q" data-explain="net" aria-label="Explain net flow"></button></div>
    <div class="bd">
      <div class="freadout" data-ref="netReadout"></div>
      <canvas class="cv" data-ref="netCv" style="height:196px" aria-label="Net flow chart"></canvas>
      <div class="stats" data-ref="stats"></div>
    </div>
  </section>
  <section class="card" id="sec-tape" data-card="tape">
    <div class="hd"><button class="fold" data-fold="tape"><h2>Big prints</h2></button><span class="meta" data-ref="tapeMeta"></span><button class="q" data-explain="tape" aria-label="Explain big prints"></button></div>
    <div class="bd">
      <div class="tape">
        <div class="tools"><div class="fseg" data-ref="tapeSeg"><button data-v="all" aria-pressed="true">≥ $100k</button><button data-v="big" aria-pressed="false">≥ $1M</button></div><span class="sub">touch list to freeze</span></div>
        <div class="paused" data-ref="paused" hidden><button data-ref="pausedBtn">Frozen · 0 new</button></div>
        <ol class="tape-list" data-ref="tape" aria-label="Big prints, newest first"></ol>
      </div>
    </div>
  </section>
  <section class="card" id="sec-events" data-card="events">
    <div class="hd"><button class="fold" data-fold="events"><h2>Walls &amp; pushes</h2></button><span class="meta" data-ref="evMeta"></span><button class="q" data-explain="events" aria-label="Explain walls and pushes"></button></div>
    <div class="bd" style="padding:0">
      <div class="tools"><div class="fseg" data-ref="evSeg"><button data-v="all" aria-pressed="true">All</button><button data-v="walls" aria-pressed="false">Walls</button><button data-v="pushes" aria-pressed="false">Pushes</button></div><span class="sub">last 40m</span></div>
      <div data-ref="events"></div>
    </div>
  </section>
  <section class="card" id="sec-book" data-card="book">
    <div class="hd"><button class="fold" data-fold="book"><h2>Order book · perps</h2></button><span class="meta" data-ref="bookMeta"></span><button class="q" data-explain="book" aria-label="Explain order book"></button></div>
    <div class="bd">
      <div class="tools" style="margin:-10px -10px 8px"><span class="sub" style="margin:0">Step</span><div class="fseg" data-ref="stepSeg"><button data-v="10">$10</button><button data-v="25">$25</button><button data-v="50">$50</button></div><span class="sub">pinch to change</span></div>
      <p class="fnote" data-ref="bookNote" style="margin:0 0 6px"></p>
      <canvas class="cv" data-ref="bookCv" style="height:350px" aria-label="Merged order book ladder"></canvas><div class="flegend"><span><i style="background:var(--ask)"></i>Asks</span><span><i style="background:var(--bid)"></i>Bids</span><span><i class="o" style="color:var(--fuel2);border-style:dashed"></i>⇄ crossed</span><span>◆ fuel</span><span class="mut">bold = 3 biggest</span></div>
    </div>
  </section>
  <section class="card" id="sec-fuel" data-card="fuel">
    <div class="hd"><button class="fold" data-fold="fuel"><h2>Fuel</h2></button><span class="meta model">our model, partial match</span><button class="q" data-explain="fuel" aria-label="Explain liquidation fuel"></button></div>
    <div class="bd">
      <div class="near" data-ref="near"></div>
      <canvas class="cv" data-ref="fuelCv" style="height:300px" aria-label="Liquidation clusters by price"></canvas>
      <div class="flegend"><span><i style="background:var(--fuel)"></i>armed</span><span><i class="o" style="color:var(--fuel2)"></i>not armed</span><span class="mut" data-ref="stopsLegend">right: HL stops</span></div><p class="fnote">Shorts above price would be forced buyers. Longs below would be forced sellers. Labels: size, distance from price.</p>
    </div>
  </section>
  <section class="card" id="sec-oi" data-card="oi">
    <div class="hd"><button class="fold" data-fold="oi"><h2>Open interest &amp; funding</h2></button><button class="q" data-explain="oi" aria-label="Explain open interest"></button></div>
    <div class="bd"><div class="ftiles" data-ref="oiTiles"></div></div>
  </section>
  <section class="card" id="sec-venues" data-card="venues">
    <div class="hd"><button class="fold" data-fold="venues"><h2>Venues</h2></button><span class="meta" data-ref="venMeta"></span><button class="q" data-explain="venues" aria-label="Explain venues"></button></div>
    <div class="bd"><div class="vn" data-ref="venues"></div></div>
  </section>
  <div class="ffoot" data-ref="footer"></div>
</div>
<div class="mini" data-ref="mini" aria-hidden="true"><div class="mini-in"><span class="sym">BTC</span><span class="mpx" data-ref="miniPx"></span><span class="mv" data-ref="miniV"></span><span class="mx" data-ref="miniX"></span></div></div>
<button class="toast" data-ref="toast" aria-live="assertive"><b data-ref="toastA"></b><span data-ref="toastB"></span><span class="tv">view ›</span></button>
<nav class="dock" aria-label="Window and sections">
  <div class="win" data-ref="winSeg" role="group" aria-label="Window"><button data-v="5m">5m</button><button data-v="12m">12m</button><button data-v="20m">20m</button></div>
  <div class="jump"><button data-jump="sec-tape">Tape</button><button data-jump="sec-book">Book</button><button data-jump="sec-fuel">Fuel</button><button data-jump="sec-venues">Venues</button></div>
</nav>
<div class="scrim" data-ref="scrim"></div>
<div class="sheet" data-ref="sheet" role="dialog" aria-modal="true" aria-labelledby="flowSheetTitle"><div class="grab"></div><h3><span id="flowSheetTitle" data-ref="sheetTitle"></span><button data-ref="sheetClose">Close</button></h3><div data-ref="sheetBody"></div></div>`;

  const FlowUI = (() => {
    const WINDOWS = { "5m": 300e3, "12m": 720e3, "20m": 1200e3 };
    const PREF_KEY = "lob.flow.v1";
    const STALE_MS = 3500, TAPE_ROWS = 30, BOOK_LEVELS = 12;
    const OK = { dark: "#3ccf8e", light: "#0b8a55", read: "#161616", warm: "#ffd27a", mono: "#ffffff" };   // LIVE badge: app chrome
    const OFF_WHY = {
      KuCoin: "KuCoin needs a connection token from a server, and this phone app has no server. So KuCoin is off on the phone and is in no total. It is about 1% of BTC perp volume.",
    };
    const EXPLAIN = {
      read: ["The read", "A one-line summary of the last minute. Buyers lead when 55% or more of perp taker volume is buying. Sellers lead at 45% or less. Spot is following when spot leans the same way. Open interest says if positions are opening or closing. Hot means perp volume is at least 2× a usual minute for this UTC hour."],
      minute: ["Taker flow", "Market orders that hit the book, summed across all live venues, for the last 60 seconds. Perps and spot are shown apart. ▲ is buying, ▼ is selling. The tick in the bar is 50/50. “× usual” compares perp volume with a typical minute this UTC hour. 2× or more is hot."],
      makers: ["Makers", "Resting quotes near price, summed across books, over the last 10 seconds. We show pulled minus added per side. Bids pulled means support is leaving. Asks pulled means resistance is leaving. Added means quotes are stacking up. On the phone we read fewer books than the Mac, so this covers roughly ±$100 to ±$200 around price."],
      net: ["Net flow", "Running total of taker buys minus taker sells since the window opened. Perps and spot have their own scales, so read each lane by its own label. Drag across the chart to read any second. Change the window with 5m, 12m, 20m at the bottom."],
      tape: ["Big prints", "Trades of $100k or more, newest first. Fills on the same venue and side, each within a quarter second of the last, are one row (×n), so a sweep shows once. $1M and above are bold and tinted. ▲ is a taker buy, ▼ a taker sell. Spot trades are tagged; the rest are perps. Touch the list to freeze it while you read; it resumes 3 seconds after you let go."],
      events: ["Walls and pushes", "A wall is a large resting order. Pulled: cancelled before price reached it. Eaten: filled by takers. Held: price tested it and it stayed. Repeats of the same wall within a minute are folded into one row (×n). A push is a burst of one-sided taking; σ is how unusual it was."],
      book: ["Order book", "Bids and asks merged across perp venues, grouped by price step. Bars are $ resting at each level. Bold rows are the three biggest levels on each side. A grey row marked ⇄ holds both bids and asks: one venue's book is behind another's. We show it rather than hide it. The dashed line is the last trade. ◆ marks a liquidation cluster from the fuel model. Pinch or tap a step to zoom. Rows far from price are partial: the books we read reach about ±$100 to ±$200."],
      fuel: ["Liquidation fuel", "Our model of where leveraged positions would be force-closed. It is a partial match to the reference feed, so treat it as a map, not a fact. Longs below price would be forced to sell. Shorts above would be forced to buy. Armed means close enough to matter. “Book 4.8× its size in the way” means the resting orders between price and the cluster are 4.8 times the cluster. Under 1× is thin: the book may not absorb it. Colours here are grey on purpose: this is a model, not trades. On the phone the model uses Binance and Bybit open interest only, and Hyperliquid stops are not scanned."],
      oi: ["Open interest and funding", "Open interest is the total of open perp positions in USD across venues. Funding is the 8 hour rate longs pay shorts; the yearly figure is that rate × 3 × 365."],
      venues: ["Venues", "Each exchange stream for the last minute. Volume, buy share and a 5 minute net bar per 10 seconds. Order is fixed so rows never jump. Lighter refuses our connection, so it is in no total. KuCoin is off on the phone. A venue that is down is left out of all totals until it is back."],
    };

    /**
     * Mount the Flow tab into root.
     * @param {HTMLElement} root empty element; the template is written into it
     * @param {{subscribe: Function}} source engine, FlowSim or FlowLife
     * @param {{theme?: string, footer?: string, offVenues?: string[]}} opts
     */
    function mount(root, source, opts = {}) {
      if (!root.firstElementChild) root.innerHTML = TEMPLATE;
      const $ = {}; for (const e of root.querySelectorAll("[data-ref]")) $[e.dataset.ref] = e;
      const store = {
        get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
        set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode: memory only */ } },
      };
      const prefs = Object.assign({ win: "20m", tape: "all", ev: "all", step: 25, closed: {}, sizes: false }, store.get(PREF_KEY) || {});
      const savePrefs = () => store.set(PREF_KEY, prefs);
      let tok = null, st = null, lastWall = 0, theme = opts.theme || "dark", pal = null, active = true;
      let scrubX = null, tapeHold = false, tapeResume = null, frozenNew = 0, tapeSeen = new Set(), firstTape = true, toastTimer = null;
      const tapeNodes = new Map();

      /* ---------- tiny DOM helpers: write only when changed ---------- */
      const txt = (e, s) => { if (e.textContent !== s) e.textContent = s; };
      const tog = (e, c, on) => e.classList.toggle(c, !!on);
      const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
      const sideCls = (x) => (x > 0 ? "buy" : x < 0 ? "sell" : "");
      const glyph = (side) => (side === "buy" ? "▲" : "▼");

      /* ---------- theme: colours live on root only, so other tabs keep theirs ---------- */
      function readPalette() {
        const cs = getComputedStyle(root), v = (n) => cs.getPropertyValue(n).trim();
        pal = { fuel: v("--fuel"), fuel2: v("--fuel2"), ink: v("--ink"), ink2: v("--ink2"), muted: v("--muted"), line: v("--line"), panel: v("--panel"), accent: v("--accent"),
                buy: v("--buy"), sell: v("--sell"), bid: v("--bid"), ask: v("--ask"), warn: v("--warn"), hatch: v("--hatch") === "1",
                mono: v("--mono") };
      }
      /** Write a theme's colours as CSS variables on root from FlowShared.Tokens (roles -> this page's variable names). */
      function themeVars(name) {
        const t = FlowShared.Tokens.get(name), r = root.style;
        tok = t;
        const v = { "--bg": t.bg, "--panel": t.panel, "--strip": t.strip, "--line": t.rule, "--ink": t.ink, "--ink2": t.ink2, "--muted": t.muted,
          "--accent": t.label, "--on-accent": t.onAlert, "--alert": t.alert, "--on-alert": t.onAlert, "--warn": t.warn,
          "--buy": t.buy, "--sell": t.sell, "--bid": t.buy, "--ask": t.sell,
          "--fuel": t.fuel, "--fuel2": t.fuelWeak, "--maker": t.maker, "--hatch": t.hatchSell ? "1" : "0", "--ok": OK[name] || t.ink2 };
        for (const k in v) r.setProperty(k, v[k]);
        r.colorScheme = t.mode;
        root.dataset.hatch = t.hatchSell ? "1" : "0";
      }
      /** Apply one of the app's themes (dark, light, read, warm, mono) to this tab. */
      function setTheme(name) {
        theme = FlowShared.Tokens.themes[name] ? name : "dark";
        themeVars(theme); readPalette();
        for (const c of canvases) c.draw();
        if (st && st.seconds.length) renderVenues();
      }

      /* ---------- canvases: sized by ResizeObserver, drawn in rAF ---------- */
      const canvases = [];
      function canvasView(cv, paint) {
        const view = { w: 0, h: 0, ctx: cv.getContext("2d"), queued: false };
        view.draw = () => { if (view.queued) return; view.queued = true; requestAnimationFrame(() => { view.queued = false; if (view.w && st && active) { view.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0); view.ctx.clearRect(0, 0, view.w, view.h); paint(view.ctx, view.w, view.h); } }); };
        new ResizeObserver(([e]) => {
          const r = e.contentRect; view.w = r.width; view.h = r.height;
          cv.width = Math.round(r.width * devicePixelRatio); cv.height = Math.round(r.height * devicePixelRatio); view.draw();
        }).observe(cv);
        canvases.push(view);
        return view;
      }
      function hatch(ctx, color) {
        const c = document.createElement("canvas"); c.width = c.height = 6;
        const x = c.getContext("2d"); x.strokeStyle = color; x.lineWidth = 1.6; x.beginPath(); x.moveTo(0, 6); x.lineTo(6, 0); x.stroke();
        return ctx.createPattern(c, "repeat");
      }
      const sellFill = (ctx) => (pal.hatch ? hatch(ctx, pal.sell) : pal.sell);
      const font = (px, w = 400) => `${w} ${px}px ${pal.mono}`;

      /* ---------- status strip, banner, mini bar ---------- */
      function renderChrome() {
        const stale = isStale(), hc = FlowDerive.healthCount(st);
        txt($.live, stale ? `◌ ${Math.round(staleFor() / 1000)}s` : st.seconds.length ? "● LIVE" : "◌ …");
        tog($.live, "stale", stale); tog($.live, "off", !st.seconds.length);
        txt($.healthTxt, `${hc.live}/${hc.total}`);
        tog($.healthDot, "partial", st.venues.some((v) => v.status === "down" || v.status === "connecting"));
        root.classList.toggle("stale", stale);
        const down = st.venues.filter((v) => v.status === "down");   // connecting is not down (new engine: connecting until first data)
        let k = "", t = "";
        if (stale) { k = "Stale"; t = `No update for ${Math.round(staleFor() / 1000)}s. Numbers are frozen at ${Fmt.time(st.now)} UTC. Reconnecting.`; }
        else if (down.length) { k = "Partial"; t = `${down.map((v) => v.name).join(", ")} down, flow reads low. Totals leave ${down.length > 1 ? "them" : "it"} out.`; }
        else if (st.seconds.length && st.seconds.length < 60) { k = "Warming"; t = `${st.seconds.length}s of data. Last-minute numbers fill in at 60s.`; }
        $.banner.hidden = !k; txt($.bannerK, k); txt($.bannerT, t);
        txt($.miniPx, Fmt.px(st.px));
      }
      const staleFor = () => Math.max(performance.now() - lastWall, st ? st.health.lagMs : 0);
      const isStale = () => !!st && st.seconds.length > 0 && staleFor() > STALE_MS;

      /* ---------- hero ---------- */
      function renderHero(lm, rd, ws) {
        txt($.px, Fmt.px(st.px));
        txt($.chg, Fmt.pct(ws.pxChg)); $.chg.className = "live-num " + sideCls(ws.pxChg);
        txt($.chgW, `in ${prefs.win}`);
        const key = rd.verdict.key, cls = key === "buyers" ? "buy" : key === "sellers" ? "sell" : "even";
        txt($.vGlyph, rd.verdict.glyph); txt($.vText, rd.label || rd.verdict.label); $.verdict.className = "verdict " + cls;
        txt($.heat, lm.heat === "hot" ? `Hot · ${Fmt.mult(lm.xUsual)}` : lm.heat === "quiet" ? `Quiet · ${Fmt.mult(lm.xUsual)}` : `${Fmt.mult(lm.xUsual)} usual`);
        $.heat.className = "heat " + lm.heat;
        tog($.hero, "hot", lm.heat === "hot"); tog($.hero, "quiet", lm.heat === "quiet");
        // sentence from the shared read; the OI clause is set in ink2 as the "why"
        const main = rd.parts.filter((x) => x.key !== "oi").map((x) => x.text).join(" ") || rd.sentence;
        const why = (rd.parts.find((x) => x.key === "oi") || {}).text || "";
        if ($.readText.dataset.s !== main + why) {
          $.readText.dataset.s = main + why;
          $.readText.replaceChildren(document.createTextNode(main + (why ? " " : "")), Object.assign(el("span", "why"), { textContent: why }));
        }
        // mini bar: the leading side's share, said plainly
        const b = lm.perpShare == null ? null : Math.round(lm.perpShare * 100);
        txt($.miniV, `${rd.verdict.glyph} ${b == null ? "No read" : key === "buyers" ? `Buyers · ${b}% buys` : key === "sellers" ? `Sellers · ${100 - b}% sells` : `Balanced · ${b}% buys`}`);
        $.miniV.className = "mv " + cls;
        txt($.miniX, lm.heat === "hot" ? `HOT ${Fmt.mult(lm.xUsual)}` : `${Fmt.mult(lm.xUsual)} usual`);
        tog($.miniX, "hot", lm.heat === "hot");
      }

      /* ---------- last minute ---------- */
      function market(box, label, buy, sell, thin) {
        if (!box.querySelector(".mkt-l1")) {
          box.innerHTML = `<div class="mkt-l1"><span><b></b><span class="shp"></span></span><span class="net live-num"></span></div><div class="mkt-l2"><span class="live-num"><span class="buy">▲</span> <span class="bv"></span></span><span class="tug-w"><span class="tug" role="img"><i class="b"></i><i class="s"></i></span></span><span class="live-num"><span class="sv"></span> <span class="sell">▼</span></span></div>`;
        }
        const tot = buy + sell, sh = tot ? buy / tot : 0.5, net = buy - sell;
        txt(box.querySelector("b"), label);
        const n = box.querySelector(".net"); txt(n, `net ${Fmt.sUsd(net)}`); n.className = "net live-num " + sideCls(net);
        box.querySelector(".b").style.width = `${(tot ? sh : 0) * 100}%`;
        box.querySelector(".s").style.width = `${(tot ? 1 - sh : 0) * 100}%`;
        box.querySelector(".tug").setAttribute("aria-label", `${label}: buy ${Fmt.usd(buy)}, sell ${Fmt.usd(sell)}`);
        txt(box.querySelector(".bv"), Fmt.usd(buy)); txt(box.querySelector(".sv"), Fmt.usd(sell));
        txt(box.querySelector(".shp"), tot ? `${Math.round(sh * 100)}% buy` : "no trades");
        tog(box, "thin", thin);
      }
      function renderMinute(lm) {
        txt($.xVal, Fmt.mult(lm.xUsual));
        $.gFill.style.width = `${Math.min(1, (lm.xUsual || 0) / 4) * 100}%`;
        tog($.gauge, "hot", lm.heat === "hot"); tog($.gauge, "past", lm.xUsual > 4); $.gOver.hidden = !(lm.xUsual > 4); txt($.gOver, `past 4× · ${Fmt.mult(lm.xUsual)}`);
        txt($.minMeta, lm.n < 60 ? `${lm.n}s of 60` : `${Fmt.usd(lm.perpBuy + lm.perpSell)} perps`);
        market($.mPerp, "Perps", lm.perpBuy, lm.perpSell, false);
        market($.mSpot, "Spot", lm.spotBuy, lm.spotSell, lm.spotBuy + lm.spotSell < 1e6);
        if (!$.sizes.hidden) {
          const r = (k, lab) => `<span class="k">${lab}</span><span class="v buy">${Fmt.usd(lm.size[k][0])}</span><span class="v sell">${Fmt.usd(lm.size[k][1])}</span><span class="v ${sideCls(lm.size[k][0] - lm.size[k][1])}">${Fmt.sUsd(lm.size[k][0] - lm.size[k][1])}</span>`;
          $.sizes.innerHTML = `<span class="h">Perp orders</span><span class="h">▲ Buy</span><span class="h">▼ Sell</span><span class="h">Net</span>` + r("small", "Under $100k") + r("mid", "$100k–1M") + r("large", "$1M +");
        }
      }

      /* ---------- makers ---------- */
      function renderMakers(mk) {
        const bar = (neg, pos, v) => {
          const scale = Math.max(2e6, Math.abs(mk.bid || 0), Math.abs(mk.ask || 0)), w = `${Math.min(50, (Math.abs(v) / scale) * 50)}%`;
          neg.style.width = v > 0 ? w : "0"; pos.style.width = v < 0 ? w : "0";
        };
        if (!mk.ok) {
          bar($.bidNeg, $.bidPos, 0); bar($.askNeg, $.askPos, 0);
          txt($.bidVal, "no data"); txt($.askVal, "no data");
          txt($.mread, `${mk.verdict}. The book feed sent no changes for 3 seconds.`);
          return;
        }
        bar($.bidNeg, $.bidPos, mk.bid); bar($.askNeg, $.askPos, mk.ask);
        const val = (v) => (v > 0 ? `pulled ${Fmt.usd(v)}` : v < 0 ? `added ${Fmt.usd(-v)}` : "flat");
        txt($.bidVal, val(mk.bid)); txt($.askVal, val(mk.ask));
        const why = { "Both sides pulling": "The book is thinning, so moves can run.", "Both sides adding": "The book is thickening.",
          "Bids thinning": "Support is leaving.", "Asks thinning": "Resistance is leaving.", "Bids building": "Support is building.",
          "Asks building": "Resistance is building.", "Steady": "" }[mk.verdict] || "";
        txt($.mread, `${mk.verdict}. ${why}`.trim());
      }

      /* ---------- net flow chart (canvas, 3 lanes, scrub) ---------- */
      let net = null;
      const netView = canvasView($.netCv, (ctx, W, H) => {
        const s = net; if (!s || s.n < 2) { ctx.fillStyle = pal.muted; ctx.font = font(12); ctx.fillText("Waiting for data…", 0, 20); return; }
        const R = 64, AX = 16, gap = 8, plotW = W - R;
        const lanes = [{ key: "px", h: 0.38 }, { key: "perp", h: 0.38 }, { key: "spot", h: 0.24 }];
        const avail = H - AX - gap * 2;
        let y0 = 0;
        const X = (t) => ((t - s.from) / (s.to - s.from)) * plotW;
        for (const ln of lanes) {
          const lh = avail * ln.h, arr = s[ln.key];
          let lo = Infinity, hi = -Infinity;
          for (let i = 0; i < s.n; i++) { lo = Math.min(lo, arr[i]); hi = Math.max(hi, arr[i]); }
          if (ln.key !== "px") { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
          const pad = (hi - lo || 1) * 0.08; lo -= pad; hi += pad;
          const Y = (v) => y0 + 4 + (lh - 8) * (1 - (v - lo) / (hi - lo));
          ctx.strokeStyle = pal.line; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(0, Math.round(y0 + lh) + 0.5); ctx.lineTo(W, Math.round(y0 + lh) + 0.5); ctx.stroke();
          if (ln.key === "px") {
            // 1 s closes bounce between bid and ask; bucket them (2/5/10 s) into a high-low band plus a close line
            const bs = (s.to - s.from) <= 300e3 ? 2 : (s.to - s.from) <= 720e3 ? 5 : 10, B = [];
            for (let i = 0; i < s.n; i++) {
              const k = Math.floor(s.t[i] / (bs * 1000)), b = B[B.length - 1];
              if (b && b.k === k) { b.hi = Math.max(b.hi, arr[i]); b.lo = Math.min(b.lo, arr[i]); b.c = arr[i]; b.t = s.t[i]; }
              else B.push({ k, hi: arr[i], lo: arr[i], c: arr[i], t: s.t[i] });
            }
            ctx.fillStyle = pal.ink2; ctx.globalAlpha = 0.2; ctx.beginPath();
            B.forEach((b, i) => { const x = X(b.t); i ? ctx.lineTo(x, Y(b.hi)) : ctx.moveTo(x, Y(b.hi)); });
            for (let i = B.length - 1; i >= 0; i--) ctx.lineTo(X(B[i].t), Y(B[i].lo));
            ctx.closePath(); ctx.fill(); ctx.globalAlpha = 1;
            ctx.strokeStyle = pal.ink2; ctx.lineWidth = 1.25; ctx.beginPath();
            B.forEach((b, i) => { const x = X(b.t), y = Y(b.c); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
            ctx.stroke();
            ctx.font = font(10); ctx.fillStyle = pal.muted; ctx.textAlign = "left";
            ctx.fillText(Fmt.px(hi - pad, 0), plotW + 6, y0 + 12); ctx.fillText(Fmt.px(lo + pad, 0), plotW + 6, y0 + lh - 5);
            ctx.fillStyle = pal.ink; ctx.font = font(11, 500);
            ctx.fillText(Fmt.px(arr[s.n - 1], 0), plotW + 6, Math.min(y0 + lh - 18, Math.max(y0 + 26, Y(arr[s.n - 1]) + 4)));
          } else {
            const zy = Y(0);
            ctx.setLineDash([2, 3]); ctx.strokeStyle = pal.muted; ctx.beginPath(); ctx.moveTo(0, zy); ctx.lineTo(plotW, zy); ctx.stroke(); ctx.setLineDash([]);
            for (const [sign, color] of [[1, pal.buy], [-1, pal.sell]]) {   // fill above/below zero by clipping
              ctx.save(); ctx.beginPath();
              if (sign > 0) ctx.rect(0, y0, plotW, zy - y0); else ctx.rect(0, zy, plotW, y0 + lh - zy);
              ctx.clip();
              ctx.beginPath(); ctx.moveTo(X(s.t[0]), zy);
              for (let i = 0; i < s.n; i++) ctx.lineTo(X(s.t[i]), Y(arr[i]));
              ctx.lineTo(X(s.t[s.n - 1]), zy); ctx.closePath();
              ctx.globalAlpha = 0.22; ctx.fillStyle = sign > 0 ? color : sellFill(ctx); ctx.fill(); ctx.globalAlpha = 1;
              ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.beginPath();
              for (let i = 0; i < s.n; i++) { const x = X(s.t[i]), y = Y(arr[i]); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
              ctx.stroke(); ctx.restore();
            }
            const end = arr[s.n - 1];
            ctx.textAlign = "left"; ctx.font = font(10, 600); ctx.fillStyle = pal.muted;
            ctx.fillText(ln.key === "perp" ? "PERPS" : "SPOT", plotW + 6, y0 + 12);
            ctx.font = font(11, 500); ctx.fillStyle = end >= 0 ? pal.buy : pal.sell;
            ctx.fillText(Fmt.sUsd(end), plotW + 6, y0 + 27);
          }
          ln.Y = Y; ln.y0 = y0; ln.lh = lh;
          y0 += lh + gap;
        }
        const x0 = X(s.t[0]);   // the window is not full yet
        if (x0 > 2) { ctx.fillStyle = pal.muted; ctx.font = font(10); ctx.textAlign = "left"; ctx.fillText("no data yet", 2, avail * 0.38 + gap + 14); }
        ctx.font = font(10); ctx.fillStyle = pal.muted;   // UTC clock ticks, same clock as the tape
        const span = s.to - s.from, stepMs = (span > 900e3 ? 5 : span > 400e3 ? 3 : 1) * 60e3;
        for (let t = Math.ceil(s.from / stepMs) * stepMs; t <= s.to; t += stepMs) {
          const x = X(t); if (x > plotW - 30) continue;
          ctx.textAlign = x < 20 ? "left" : "center"; ctx.fillText(Fmt.hm(t), x, H - 3);
        }
        ctx.textAlign = "right"; ctx.fillStyle = pal.ink2; ctx.fillText(`${Fmt.hm(s.to)} UTC`, W, H - 3);
        if (scrubX != null) {
          const tx = s.from + (Math.max(0, Math.min(plotW, scrubX)) / plotW) * (s.to - s.from);
          let i = 0; while (i < s.n - 1 && s.t[i + 1] <= tx) i++;
          const x = X(s.t[i]);
          ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + 0.5, 0); ctx.lineTo(x + 0.5, H - AX); ctx.stroke();
          for (const ln of lanes) { ctx.fillStyle = pal.ink; ctx.beginPath(); ctx.arc(x, ln.Y(s[ln.key][i]), 3, 0, 7); ctx.fill(); }
          setReadout(i);
        }
      });
      function setReadout(i) {
        const s = net; if (!s || !s.n) { txt($.netReadout, ""); return; }
        const k = i ?? s.n - 1, cls = (v) => (v >= 0 ? "buy" : "sell");
        const html = `<b>${i == null ? "Now" : Fmt.time(s.t[k])}</b> · ${Fmt.px(s.px[k], 0)} · perps <span class="${cls(s.perp[k])}">${Fmt.sUsd(s.perp[k])}</span> · spot <span class="${cls(s.spot[k])}">${Fmt.sUsd(s.spot[k])}</span>`;
        if ($.netReadout.dataset.h !== html) { $.netReadout.dataset.h = html; $.netReadout.innerHTML = html; }
      }
      $.netCv.addEventListener("pointerdown", (e) => { scrubX = e.offsetX; netView.draw(); });
      $.netCv.addEventListener("pointermove", (e) => { if (scrubX != null || e.pointerType === "mouse") { scrubX = e.offsetX; netView.draw(); } });
      const endScrub = () => { scrubX = null; setReadout(null); netView.draw(); };
      $.netCv.addEventListener("pointerup", endScrub); $.netCv.addEventListener("pointercancel", endScrub); $.netCv.addEventListener("pointerleave", endScrub);

      function renderNet(ws) {
        txt($.netTitle, `Net flow · since ${prefs.win}`);
        net = FlowDerive.netSeries(st, WINDOWS[prefs.win]);
        if (scrubX == null) setReadout(null);
        netView.draw();
        const b = ws.biggest;
        const stat = (k, v, s, c = "") => `<div class="stat"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
        const html =
          stat("Perp bought", `▲ ${Fmt.usd(ws.bought)}`, `${ws.bought + ws.sold ? Math.round(ws.bought / (ws.bought + ws.sold) * 100) : 0}% of perp vol`, "buy") +
          stat("Perp sold", `▼ ${Fmt.usd(ws.sold)}`, `net ${Fmt.sUsd(ws.bought - ws.sold)}`, "sell") +
          stat("Biggest", b ? `${glyph(b.side)} ${Fmt.usd(b.usd)}` : "–", b ? `${b.venue} · ${Fmt.hm(b.t)}` : "no prints", b ? b.side : "") +
          stat("$1M+ prints", String(ws.big), `${ws.prints} over $100k`) +
          stat("Sweeps", String(ws.sweeps), ws.sweeps ? "price levels cleared" : "none this window") +
          stat("Pushes", String(ws.pushes), "2σ or more");
        if ($.stats.dataset.h !== html) { $.stats.dataset.h = html; $.stats.innerHTML = html; }
      }

      /* ---------- tape ---------- */
      function printRow(p, fresh) {
        const li = el("li", `pr ${p.side}${p.usd >= FlowDerive.BIG ? " big" : ""}${fresh ? " fresh" : ""}`);
        const w = Math.max(0.06, Math.min(1, Math.log10(p.usd / 1e5) / 2)), n = p.count || 1;
        const tags = (n > 1 ? ` <b class="cnt">×${n}</b>` : "") + (p.kind === "spot" ? ' <span class="tag">spot</span>' : "");
        li.innerHTML = `<span class="t">${Fmt.time(p.t)}</span><span class="a"><span class="${p.side}">${glyph(p.side)}</span> ${Fmt.usd(p.usd)}</span><span class="sz" style="width:${(w * 100).toFixed(0)}%"></span><span class="v">${p.venue.replace(" spot", "")}${tags}</span><span class="p">${Fmt.px(p.pxLast ?? p.px, 0)}</span>`;
        li.setAttribute("aria-label", `${Fmt.time(p.t)} ${p.side} ${Fmt.usd(p.usd)}${n > 1 ? ` in ${n} fills` : ""} on ${p.venue} ${p.kind} at ${Fmt.px(p.px, 0)}`);
        li.dataset.id = p.id;
        return li;
      }
      let alertSeen = null, clusterById = new Map();
      function renderTape(ws) {
        const min = prefs.tape === "big" ? FlowDerive.BIG : 1e5;
        const clusters = FlowDerive.clusters(st.prints.slice(Math.max(0, st.prints.length - 400)));
        const list = [];
        for (let k = clusters.length - 1; k >= 0 && list.length < TAPE_ROWS; k--) if (clusters[k].usd >= min) list.push(clusters[k]);
        clusterById = new Map(list.map((c) => [c.id, c]));
        const key = (c) => `${c.id}:${c.count}`;
        const newOnes = list.filter((p) => !tapeSeen.has(key(p)));
        for (const p of newOnes) tapeSeen.add(key(p));
        txt($.tapeMeta, `${ws.prints} in ${prefs.win} · ${ws.big} ≥ $1M`);
        if (tapeHold) { frozenNew += newOnes.length; txt($.pausedBtn, `Frozen · ${frozenNew} new`); return; }
        const nodes = list.map((p) => {
          let n = tapeNodes.get(key(p));
          if (!n) { n = printRow(p, !firstTape); tapeNodes.set(key(p), n); }
          return n;
        });
        const keep = new Set(list.map(key));
        for (const id of tapeNodes.keys()) if (!keep.has(id)) tapeNodes.delete(id);
        const cur = [...$.tape.children];
        if (cur.length !== nodes.length || cur.some((c, i) => c !== nodes[i])) $.tape.replaceChildren(...nodes);
        if (!list.length) $.tape.replaceChildren(el("li", "tape-empty", prefs.tape === "big" ? "No $1M prints in the last 20 minutes." : "No prints over $100k yet."));
        if (tapeSeen.size > 4000) tapeSeen = new Set(list.map(key));
        firstTape = false;
      }
      /** Alerts come from the shared rule set (2× usual, $5M print, wall eaten, push z ≥ 4), so the phone and Mac alert on the same things. */
      function checkAlerts() {
        const all = FlowDerive.alerts(st), ids = new Set(all.map((a) => a.id));
        if (alertSeen) { const fresh = all.filter((a) => !alertSeen.has(a.id) && a.t >= st.now - 5000); if (fresh.length) toast(fresh[fresh.length - 1]); }
        alertSeen = ids;
      }
      function toast(a) {
        txt($.toastA, a.text); txt($.toastB, a.sub);
        $.toast.dataset.target = !a.source ? "sec-read" : a.source.type === "print" ? "sec-tape" : "sec-events";
        $.toast.classList.add("on");
        clearTimeout(toastTimer); toastTimer = setTimeout(() => $.toast.classList.remove("on"), 5000);
      }
      $.toast.onclick = () => { $.toast.classList.remove("on"); jump($.toast.dataset.target || "sec-tape"); };
      const holdTape = () => { tapeHold = true; clearTimeout(tapeResume); $.paused.hidden = false; txt($.pausedBtn, `Frozen · ${frozenNew} new`); };
      const releaseTape = () => { clearTimeout(tapeResume); tapeResume = setTimeout(resumeTape, 3000); };
      const resumeTape = () => { tapeHold = false; frozenNew = 0; $.paused.hidden = true; if (st) render(); };
      $.tape.addEventListener("pointerdown", holdTape); $.tape.addEventListener("pointerup", releaseTape); $.tape.addEventListener("pointercancel", releaseTape);
      $.pausedBtn.onclick = resumeTape;
      $.tape.addEventListener("click", (e) => { const li = e.target.closest(".pr"); if (li) printSheet(li.dataset.id); });

      /* ---------- events ---------- */
      function renderEvents() {
        const filter = { all: "all", walls: "wall", pushes: "push" }[prefs.ev];
        const items = FlowDerive.events(st, filter, 12);
        txt($.evMeta, `${st.walls.filter((w) => w.t >= st.now - 600e3).length} walls / 10m`);
        const wallTxt = { pulled: ["□", "wall pulled"], eaten: ["×", "wall eaten"], held: ["■", "wall held"], flicker: ["◫", "wall flickered"] };
        const flag = (r) => (r.alert ? '<span class="flag">alert</span>' : "");
        const html = items.map((r) => {
          if (r.type === "wall") {
            const w = r.wall, [g, word] = wallTxt[w.kind] || ["□", `wall ${w.kind}`], side = w.side === "bid" ? "Bid" : "Ask", c = w.side === "bid" ? "buy" : "sell";
            const rep = w.count > 1 ? `<span class="x">×${w.count} in ${Math.max(1, Math.round((w.t - w.firstT) / 1000))}s</span>` : "";
            return `<div class="ev${r.alert ? " al" : ""}"><span class="g ${c}">${g}</span><span class="l1">${side} ${word}${rep}${flag(r)}</span><span class="u">${Fmt.usd(w.usd)}</span><span class="l2">${Fmt.px(w.px, 0)} · ${w.venue} · ${Fmt.time(w.t)} · ${Fmt.ago(w.t, st.now)}</span></div>`;
          }
          if (r.type === "push") {
            const q = r.push, c = q.side;
            return `<div class="ev push${r.alert ? " al" : ""}"><span class="g ${c}">${q.side === "buy" ? "⇡" : "⇣"}</span><span class="l1 ${c}">${q.side === "buy" ? "Buy" : "Sell"} ${q.kind}<span class="x">${Fmt.z(q.z)}</span>${flag(r)}</span><span class="u ${c}">${Fmt.usd(q.usd)}</span><span class="l2">${Fmt.px(q.px, 0)} · ${q.venue} · ${Fmt.time(q.t)} · ${Fmt.ago(q.t, st.now)}</span></div>`;
          }
          const a = r.alertRow;
          return `<div class="ev al"><span class="g">!</span><span class="l1">${a.text}<span class="flag">alert</span></span><span class="u"></span><span class="l2">${a.sub} · ${Fmt.time(a.t)} · ${Fmt.ago(a.t, st.now)}</span></div>`;
        }).join("") || `<div class="tape-empty">Nothing in the last 40 minutes.</div>`;
        if ($.events.dataset.h !== html) { $.events.dataset.h = html; $.events.innerHTML = html; }
      }

      /* ---------- order book ladder (canvas) ---------- */
      const bookView = canvasView($.bookCv, (ctx, W, H) => {
        const L = FlowDerive.ladder(st, prefs.step, BOOK_LEVELS);
        if (!L) { ctx.fillStyle = pal.muted; ctx.font = font(12); ctx.fillText("Book loading…", 0, 20); return; }
        const rh = H / L.rows.length, PX = 58, VAL = 62, barW = W - PX - VAL - 14;
        const max = Math.max(...L.rows.map((r) => Math.max(r.bid, r.ask)), 1);
        const fuel = st.fuel ? st.fuel.levels : [];
        ctx.textBaseline = "middle";
        L.rows.forEach((r, k) => {
          const y = k * rh, cy = y + rh / 2;
          ctx.font = font(11); ctx.textAlign = "right";
          if (r.kind === "empty") { ctx.fillStyle = pal.line; ctx.fillText(Fmt.px(r.px, 0), PX - 6, cy); ctx.fillStyle = pal.muted; ctx.fillText("–", W - 16, cy); return; }
          if (r.kind === "crossed") {
            // both sides rest here: venues out of step. Muted, split bar (ask on top, bid below), labelled.
            ctx.strokeStyle = pal.fuel2; ctx.lineWidth = 1; ctx.setLineDash([2, 2]);
            ctx.strokeRect(PX + 0.5, y + 2.5, Math.max(2, (r.ask / max) * barW), rh / 2 - 3);
            ctx.strokeRect(PX + 0.5, cy + 1, Math.max(2, (r.bid / max) * barW), rh / 2 - 3.5);
            ctx.setLineDash([]);
            ctx.fillStyle = pal.muted; ctx.fillText(Fmt.px(r.px, 0), PX - 6, cy);
            ctx.strokeStyle = pal.muted; ctx.lineWidth = 1; const tw = ctx.measureText(Fmt.px(r.px, 0)).width;
            ctx.beginPath(); ctx.moveTo(PX - 6 - tw, Math.round(cy) + 0.5); ctx.lineTo(PX - 6, Math.round(cy) + 0.5); ctx.stroke();
            ctx.fillText(`⇄ ${Fmt.usd(r.bid + r.ask)}`, W - 16, cy);
          } else {
            const ask = r.kind === "ask", usd = ask ? r.ask : r.bid, big = (ask ? L.topAsk : L.topBid).has(r.px), c = ask ? pal.ask : pal.bid;
            const hatched = ask && pal.hatch;
            ctx.globalAlpha = big ? 0.95 : hatched ? 0.8 : 0.5;
            ctx.fillStyle = hatched ? hatch(ctx, c) : c;
            ctx.fillRect(PX, y + 2, Math.max(1, (usd / max) * barW), rh - 4);
            ctx.globalAlpha = 1;
            ctx.font = font(11, big ? 600 : 400);
            ctx.fillStyle = big ? pal.ink : pal.ink2; ctx.fillText(Fmt.px(r.px, 0), PX - 6, cy);
            ctx.fillText(Fmt.usd(usd), W - 16, cy);
          }
          const f = fuel.find((l) => l.px >= r.px - L.step / 2 && l.px < r.px + L.step / 2);
          if (f) { ctx.fillStyle = pal.fuel; ctx.font = font(10); ctx.textAlign = "right"; ctx.fillText("◆", W - 2, cy); }
        });
        const ly = ((L.top - st.px) / L.step) * rh + rh / 2;   // last trade at its true position on the grid
        if (ly > 0 && ly < H) {
          ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.setLineDash([4, 3]);
          ctx.beginPath(); ctx.moveTo(PX, Math.round(ly) + 0.5); ctx.lineTo(W - VAL - 6, Math.round(ly) + 0.5); ctx.stroke(); ctx.setLineDash([]);
          ctx.fillStyle = pal.ink; ctx.beginPath(); ctx.moveTo(PX - 4, ly - 4); ctx.lineTo(PX + 2, ly); ctx.lineTo(PX - 4, ly + 4); ctx.fill();
        }
        ctx.textBaseline = "alphabetic";
        const note = `▸ dashed line = last trade ${Fmt.px(st.px)}. Within ±0.2%: bids ${Fmt.usd(L.nearBid)}, asks ${Fmt.usd(L.nearAsk)}.` + (L.crossed ? ` ${Fmt.usd(L.crossedUsd)} crossed: venues out of step.` : "");
        if ($.bookNote.textContent !== note) $.bookNote.textContent = note;
      });
      const pts = new Map(); let pinch0 = null;   // pinch to change step
      const spread = () => { const v = [...pts.values()]; return Math.abs(v[0] - v[1]) || 1; };
      $.bookCv.addEventListener("pointerdown", (e) => { pts.set(e.pointerId, e.clientY); if (pts.size === 2) pinch0 = spread(); });
      $.bookCv.addEventListener("pointermove", (e) => {
        if (!pts.has(e.pointerId)) return; pts.set(e.pointerId, e.clientY);
        if (pts.size === 2 && pinch0) { const r = spread() / pinch0, steps = [10, 25, 50], i = steps.indexOf(prefs.step);
          if (r > 1.35 && i > 0) { setStep(steps[i - 1]); pinch0 = spread(); } else if (r < 0.74 && i < 2) { setStep(steps[i + 1]); pinch0 = spread(); } }
      });
      const lift = (e) => { pts.delete(e.pointerId); if (pts.size < 2) pinch0 = null; };
      $.bookCv.addEventListener("pointerup", lift); $.bookCv.addEventListener("pointercancel", lift);
      function setStep(s) { prefs.step = s; savePrefs(); paintSeg($.stepSeg, String(s)); bookView.draw(); }

      /* ---------- fuel (canvas) ---------- */
      const fuelView = canvasView($.fuelCv, (ctx, W, H) => {
        const f = st.fuel; if (!f || !f.levels.length) { ctx.fillStyle = pal.muted; ctx.font = font(12); ctx.fillText(f ? "No clusters within range." : "Fuel model loading…", 0, 20); return; }
        const P = st.px, span = 0.06, hiP = P * (1 + span), loP = P * (1 - span);
        const stops = f.stops || [], AX = 52, STOPS = stops.length ? 40 : 0, top = 6, bot = H - 6;
        const Y = (p) => top + (bot - top) * (hiP - p) / (hiP - loP);
        const LBL = 92, barMax = W - AX - STOPS - LBL - 8, max = Math.max(...f.levels.map((l) => l.usd));
        ctx.font = font(10); ctx.textBaseline = "middle";
        for (let pc = -6; pc <= 6; pc += 2) {
          const y = Y(P * (1 + pc / 100));
          ctx.strokeStyle = pal.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(AX, Math.round(y) + 0.5); ctx.lineTo(W, Math.round(y) + 0.5); ctx.stroke();
          if (pc) { ctx.fillStyle = pal.muted; ctx.textAlign = "right"; ctx.fillText(`${pc > 0 ? "+" : Fmt.MINUS}${Math.abs(pc)}%`, AX - 6, y); }
        }
        if (stops.length) {   // HL stops column (not scanned in phone mode)
          ctx.fillStyle = pal.muted; ctx.textAlign = "center"; ctx.fillText("HL", W - STOPS / 2, top + 4);
          const smax = Math.max(...stops.map((s) => s.usd), 1);
          for (const s of stops) {
            if (s.px > hiP || s.px < loP) continue;
            const y = Y(s.px), len = 4 + (s.usd / smax) * (STOPS - 10);
            ctx.fillStyle = pal.fuel2; ctx.fillRect(W - STOPS + 4, y - 1, len, 2);
          }
        }
        const ranked = [...f.levels].sort((a, b) => b.usd - a.usd).slice(0, 5).map((l) => l.px);
        const labelled = [];   // y of labels drawn; biggest first wins a slot
        const wantLabel = new Set([...f.levels].filter((l) => l.px <= hiP && l.px >= loP && (l.armed || ranked.includes(l.px)))
          .sort((a, b) => b.usd - a.usd).filter((l) => { const y = Y(l.px); if (labelled.some((u) => Math.abs(u - y) < 13)) return false; labelled.push(y); return true; }).map((l) => l.px));
        for (const l of f.levels) {
          if (l.px > hiP || l.px < loP) continue;
          const y = Y(l.px), len = Math.max(2, (l.usd / max) * barMax);
          if (l.armed) { ctx.fillStyle = pal.fuel; ctx.fillRect(AX + 4, y - 3.5, len, 7); }
          else { ctx.strokeStyle = pal.fuel2; ctx.lineWidth = 1.25; if (tok && tok.fuelStyle === "dots") ctx.setLineDash([2, 2]); ctx.strokeRect(AX + 4.5, y - 3, len - 1, 6); ctx.setLineDash([]); }
          if (wantLabel.has(l.px)) {
            ctx.fillStyle = pal.ink2; ctx.textAlign = "left"; ctx.font = font(10, l.armed ? 600 : 400);
            ctx.fillText(`${Fmt.usd(l.usd)} ${Fmt.pct((l.px / P - 1) * 100, 1)}`, AX + 10 + barMax, y);
            ctx.strokeStyle = pal.line; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(AX + 6 + len, Math.round(y) + 0.5); ctx.lineTo(AX + 6 + barMax, Math.round(y) + 0.5); ctx.stroke();
          }
        }
        const py = Y(P);
        ctx.strokeStyle = pal.ink; ctx.lineWidth = 1; ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(AX, py); ctx.lineTo(W - STOPS, py); ctx.stroke(); ctx.setLineDash([]);
        ctx.fillStyle = pal.ink; ctx.font = font(11, 600); ctx.textAlign = "right"; ctx.fillText(Fmt.px(P, 0), AX - 4, py);
        ctx.textBaseline = "alphabetic";
      });
      function renderFuel() {
        const n = FlowDerive.fuelNear(st);
        $.stopsLegend.hidden = !(st.fuel && st.fuel.stops && st.fuel.stops.length);
        if (!n) { $.near.innerHTML = ""; fuelView.draw(); return; }
        const row = (lab, l) => !l ? `<div class="r"><b>${lab}</b><span class="mut">none in range</span></div>` :
          `<div class="r"><b>${lab}</b><span><b class="fz">${l.side === "longs" ? "Longs" : "Shorts"} ${Fmt.usd(l.usd)}</b> at ${Fmt.px(l.px, 0)} <span class="mut">(${Fmt.pct(l.distPct, 1)})</span><span class="s">${l.side === "longs" ? "forced sellers" : "forced buyers"} if hit · ${l.armed ? "armed" : "not armed"} · book ${Fmt.mult(l.cover)} its size in the way${l.cover < 1 ? ' <span class="model">thin</span>' : ""}</span></span></div>`;
        const html = row("Above", n.above) + row("Below", n.below);
        if ($.near.dataset.h !== html) { $.near.dataset.h = html; $.near.innerHTML = html; }
        fuelView.draw();
      }

      /* ---------- OI ---------- */
      function renderOI() {
        const o = st.oi;
        const tile = (k, v, s, c = "") => `<div class="ftile"><div class="k">${k}</div><div class="v ${c}">${v}</div><div class="s">${s}</div></div>`;
        const html = !o ? tile("Open interest", "–", "loading") :
          tile("Open interest", Fmt.usd(o.usd), `as of ${Fmt.time(o.at)}`) +
          tile("Change 5m", Fmt.pct(o.d5Pct, 3), o.d5Pct == null ? "–" : Math.abs(o.d5Pct) < 0.03 ? "flat" : `${Fmt.sUsd(o.usd * o.d5Pct / 100)}`, sideCls(o.d5Pct)) +
          tile("Change 1h", o.d1hPct == null ? "–" : Fmt.pct(o.d1hPct, 2), o.d1hPct == null ? "needs 1h of data" : "", sideCls(o.d1hPct)) +
          tile("Funding 8h", o.funding8h == null ? "–" : Fmt.pct(o.funding8h * 100, 4), o.funding8h == null ? "" : `${Fmt.pct(o.funding8h * 3 * 365 * 100, 1)} a year · ${o.funding8h >= 0 ? "longs pay" : "shorts pay"}`);
        if ($.oiTiles.dataset.h !== html) { $.oiTiles.dataset.h = html; $.oiTiles.innerHTML = html; }
      }

      /* ---------- venues ---------- */
      const vRows = new Map();
      const SYM = { live: "●", connecting: "◌", down: "✕", blocked: "⊘", off: "⊘" };
      const WHY = { down: "down", blocked: "blocked", off: "off on phone", connecting: "connecting", live: "" };
      function renderVenues() {
        const list = FlowDerive.venues(st);
        if (!vRows.size) {
          const frag = document.createDocumentFragment();
          frag.append(Object.assign(el("div", "vhead"), { innerHTML: "<span></span><span>Venue</span><span>1m</span><span>Buy %</span><span>Net 5m</span>" }));
          let grp = null;
          for (const v of list) {
            if (v.kind !== grp) { grp = v.kind; frag.append(el("div", "vgrp", grp === "perp" ? "Perps" : "Spot")); }
            const b = el("button", "vr"); b.innerHTML = `<span class="st"></span><span class="nm">${v.name.replace(" spot", "")}</span><span class="vol live-num"></span><span class="shr"><i></i><i></i></span><canvas></canvas>`;
            b.onclick = () => venueSheet(v.name);
            frag.append(b); vRows.set(v.name, { b, cv: b.querySelector("canvas") });
          }
          const note = el("div", "vnote", "Data use: about 100 to 250 MB an hour in a busy market. Streams close 60 s after you leave this tab.");
          note.style.cssText = "color:var(--muted);font-size:12px;padding:10px 4px 2px";
          frag.append(note);
          $.venues.replaceChildren(frag);
        }
        const hc = FlowDerive.healthCount(st);
        txt($.venMeta, [`${hc.live}/${hc.total} live`, ...hc.notes].join(" · "));
        for (const v of list) {
          const r = vRows.get(v.name); if (!r) continue;
          const st0 = r.b.querySelector(".st"); txt(st0, SYM[v.status] || "?"); st0.style.color = v.status === "live" ? "var(--ok)" : v.status === "down" ? "var(--warn)" : "var(--muted)";
          r.b.className = `vr ${v.status !== "live" ? "off" : ""} is-${v.status === "off" ? "blocked" : v.status}`;
          r.b.querySelector(".nm").dataset.why = WHY[v.status] ?? v.status;
          txt(r.b.querySelector(".vol"), v.status === "blocked" || v.status === "off" ? "–" : Fmt.usd(v.vol));
          const [bi, si] = r.b.querySelectorAll(".shr i"); const sh = v.vol ? v.share : 0;
          bi.style.width = `${v.vol ? sh * 100 : 0}%`; si.style.width = `${v.vol ? (1 - sh) * 100 : 0}%`;
          r.b.setAttribute("aria-label", `${v.name} ${WHY[v.status] || v.status}, last minute ${Fmt.usd(v.vol)}, ${v.vol ? Math.round(sh * 100) : 0}% buy`);
          spark(r.cv, v.spark, v.status === "live");
        }
      }
      function spark(cv, arr, on) {
        const w = 66, h = 20, d = devicePixelRatio;
        if (cv.width !== w * d) { cv.width = w * d; cv.height = h * d; }
        const ctx = cv.getContext("2d"); ctx.setTransform(d, 0, 0, d, 0, 0); ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = pal.line; ctx.fillRect(0, h / 2, w, 1);
        if (!on) return;
        const m = Math.max(...Array.from(arr, Math.abs), 1), bw = w / arr.length;
        for (let i = 0; i < arr.length; i++) {
          const v = arr[i], len = (Math.abs(v) / m) * (h / 2 - 1); if (!len) continue;
          ctx.fillStyle = v > 0 ? pal.buy : pal.sell;
          ctx.fillRect(i * bw + 0.5, v > 0 ? h / 2 - len : h / 2 + 1, bw - 1, len);
        }
      }

      /* ---------- sheets (explain, venue, print, health) ---------- */
      function openSheet(title, html) {
        txt($.sheetTitle, title); $.sheetBody.innerHTML = html;
        $.sheet.classList.add("on"); $.scrim.classList.add("on"); $.sheetClose.focus();
      }
      function closeSheet() { $.sheet.classList.remove("on"); $.scrim.classList.remove("on"); }
      $.scrim.onclick = closeSheet; $.sheetClose.onclick = closeSheet;
      document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeSheet(); });
      root.addEventListener("click", (e) => {
        const q = e.target.closest("[data-explain]"); if (q) { const [t, b] = EXPLAIN[q.dataset.explain]; openSheet(t, `<p>${b}</p>`); }
      });
      function venueSheet(name) {
        if (!st) return;
        const v = FlowDerive.venues(st).find((x) => x.name === name);
        const ps = st.prints.filter((p) => p.venue === name).slice(-8).reverse();
        const why = v.status === "blocked" ? "<p>Lighter refuses connections from our region. We get no data from it, so it is not in any total. This is not an outage on our side.</p>" :
                    v.status === "off" ? `<p>${OFF_WHY[name] || "This venue is off on the phone. It is in no total."}</p>` :
                    v.status === "down" ? "<p>This feed is down. Its trades are left out of every total until it reconnects, so flow reads low.</p>" : "";
        openSheet(name, `${why}<dl class="fkv"><dt>Status</dt><dd>${WHY[v.status] || v.status}</dd><dt>Type</dt><dd>${v.kind}</dd><dt>Last min ▲ buy</dt><dd class="buy">${Fmt.usd(v.buy)}</dd><dt>Last min ▼ sell</dt><dd class="sell">${Fmt.usd(v.sell)}</dd><dt>Share of all volume</dt><dd>${(v.ofTotal * 100).toFixed(1)}%</dd></dl>` +
          (ps.length ? `<ol class="tape-list" style="margin:0 -16px">${ps.map((p) => printRow(p, false).outerHTML).join("")}</ol>` : `<p class="mut">No prints over $100k in 20 minutes.</p>`));
      }
      function printSheet(id) {
        const p = clusterById.get(id) || st.prints.find((x) => x.id === id); if (!p) return;
        openSheet(`${p.side === "buy" ? "▲ Buy" : "▼ Sell"} ${Fmt.usd(p.usd)}`, `<dl class="fkv"><dt>Time</dt><dd>${Fmt.time(p.t)} UTC</dd><dt>Venue</dt><dd>${p.venue}</dd><dt>Market</dt><dd>${p.kind}</dd>${p.count > 1 ? `<dt>Fills</dt><dd>${p.count} within ${FlowDerive.RULES.PRINT_CLUSTER_MS} ms of each other</dd><dt>Price</dt><dd>${Fmt.px(p.pxFirst)} → ${Fmt.px(p.pxLast)}</dd>` : `<dt>Price</dt><dd>${Fmt.px(p.px)}</dd>`}<dt>vs now</dt><dd>${Fmt.pct((st.px / p.px - 1) * 100)}</dd><dt>Size</dt><dd>${(p.usd / p.px).toFixed(2)} BTC</dd>${p.wallet ? `<dt>Wallet</dt><dd>${p.wallet.slice(0, 6)}…${p.wallet.slice(-4)}</dd>` : ""}</dl>`);
      }
      $.healthBtn.onclick = () => {
        if (!st) return;
        const rows = st.venues.map((v) => `<dt>${v.name}</dt><dd class="${v.status === "live" ? "" : "model"}">${WHY[v.status] || v.status}</dd>`).join("");
        const hc = FlowDerive.healthCount(st);
        openSheet("Venue health", `<p>${hc.live} of ${hc.total} venues live.${hc.notes.length ? ` ${hc.notes.join(". ")}.` : ""} Engine lag ${st.health.lagMs} ms.</p><dl class="fkv">${rows}</dl>`);
      };

      /* ---------- controls ---------- */
      function paintSeg(seg, v) { for (const b of seg.querySelectorAll("button")) b.setAttribute("aria-pressed", String(b.dataset.v === v)); }
      function bindSeg(seg, key, after) {
        paintSeg(seg, String(prefs[key]));
        for (const b of seg.querySelectorAll("button")) b.onclick = () => {
          prefs[key] = key === "step" ? +b.dataset.v : b.dataset.v; savePrefs(); paintSeg(seg, b.dataset.v); after();
        };
      }
      bindSeg($.winSeg, "win", () => st && render());
      bindSeg($.tapeSeg, "tape", () => { tapeNodes.clear(); firstTape = true; st && render(); });
      bindSeg($.evSeg, "ev", () => st && renderEvents());
      bindSeg($.stepSeg, "step", () => bookView.draw());
      const applySizes = () => { $.sizes.hidden = !prefs.sizes; $.sizesBtn.setAttribute("aria-expanded", String(prefs.sizes)); };
      $.sizesBtn.onclick = () => { prefs.sizes = !prefs.sizes; savePrefs(); applySizes(); st && st.seconds.length && renderMinute(FlowDerive.lastMinute(st)); };
      applySizes();
      for (const b of root.querySelectorAll("[data-fold]")) {
        const card = b.closest(".card"), key = b.dataset.fold;
        card.classList.toggle("closed", !!prefs.closed[key]); b.setAttribute("aria-expanded", String(!prefs.closed[key]));
        b.onclick = () => { prefs.closed[key] = !prefs.closed[key]; savePrefs(); card.classList.toggle("closed", prefs.closed[key]); b.setAttribute("aria-expanded", String(!prefs.closed[key])); if (st) render(); };
      }
      function jump(id) {
        const card = document.getElementById(id);
        const key = card.dataset.card; if (key && prefs.closed[key]) card.querySelector("[data-fold]").click();
        card.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
      }
      for (const b of root.querySelectorAll("[data-jump]")) b.onclick = () => jump(b.dataset.jump);
      new IntersectionObserver(([e]) => $.mini.classList.toggle("on", !e.isIntersecting && active), { rootMargin: "-40px 0px 0px 0px" }).observe($.hero);

      /* ---------- loading skeleton ---------- */
      function renderLoading() {
        const hc = FlowDerive.healthCount(st);
        txt($.live, "◌ …"); $.live.className = "f-live off";
        txt($.healthTxt, `${hc.live}/${hc.total}`); tog($.healthDot, "partial", true);
        $.banner.hidden = false; txt($.bannerK, "Connecting"); txt($.bannerT, `${hc.live} of ${hc.total} venues up. First numbers in a few seconds.`);
        for (const k of ["px", "chg", "heat", "xVal", "readText"]) $[k].classList.add("sk");
        txt($.px, "00,000.0"); txt($.chg, "+0.00%"); txt($.heat, "0.0× usual"); txt($.xVal, "0.0×");
        $.readText.textContent = "Sellers in control. Spot not following."; delete $.readText.dataset.s;
        txt($.vText, "Waiting"); txt($.vGlyph, "◌"); $.verdict.className = "verdict even";
        for (const box of [$.mPerp, $.mSpot]) box.innerHTML = `<div class="sk" style="height:12px;width:40%"></div><div class="sk" style="height:10px;margin:6px 0"></div><div class="sk" style="height:12px;width:70%"></div>`;
        txt($.bidVal, "–"); txt($.askVal, "–"); txt($.mread, "Waiting for book updates.");
        txt($.netReadout, ""); delete $.netReadout.dataset.h; $.stats.innerHTML = ""; delete $.stats.dataset.h;
        $.tape.replaceChildren(el("li", "tape-empty", "Listening for prints over $100k.")); tapeNodes.clear(); firstTape = true;
        $.events.innerHTML = `<div class="tape-empty">Listening for walls and pushes.</div>`; delete $.events.dataset.h;
        renderVenues(); renderOI(); $.near.innerHTML = ""; delete $.near.dataset.h;
        net = null;
        for (const c of canvases) c.draw();
      }
      // Empty the skeleton boxes first: once the .sk class is gone they can no longer be found.
      const clearSk = () => { for (const box of [$.mPerp, $.mSpot]) if (box.querySelector(".sk")) box.innerHTML = ""; for (const e of root.querySelectorAll(".sk")) e.classList.remove("sk"); };

      /* ---------- main render ---------- */
      function render() {
        if (!st.seconds.length) return renderLoading();
        clearSk();
        const lm = FlowDerive.lastMinute(st), rd = FlowDerive.read(st), ws = FlowDerive.windowStats(st, WINDOWS[prefs.win]);
        renderChrome(); renderHero(lm, rd, ws); renderMinute(lm); renderMakers(FlowDerive.makers(st)); renderNet(ws);
        checkAlerts();
        if (!prefs.closed.tape) renderTape(ws);
        if (!prefs.closed.events) renderEvents();
        if (!prefs.closed.book) { bookView.draw(); txt($.bookMeta, st.book ? `as of ${Fmt.ago(st.book.at, st.now)}` : "loading"); }
        if (!prefs.closed.fuel) renderFuel();
        if (!prefs.closed.oi) renderOI();
        if (!prefs.closed.venues) renderVenues();
        txt($.footer, `${opts.footer || ""}Times UTC. Engine lag ${st.health.lagMs} ms. Book at ${Fmt.time(st.book ? st.book.at : st.now)}.`);
      }

      setTheme(theme);
      const unsub = source.subscribe((s) => { st = FlowDerive.markOff(s, opts.offVenues); lastWall = performance.now(); if (active) render(); });
      const staleTimer = setInterval(() => { if (active && st && st.seconds.length) renderChrome(); }, 1000);
      return {
        setTheme,
        /** Rendering on (tab shown) or off. Turning it on renders the latest state at once. */
        setActive(on) { active = !!on; if (!active) { closeSheet(); $.mini.classList.remove("on"); } else if (st) { render(); for (const c of canvases) c.draw(); } },
        destroy() { unsub(); clearInterval(staleTimer); },
        jump, venueSheet,
        openExplain: (k) => { const [t, b] = EXPLAIN[k]; openSheet(t, `<p>${b}</p>`); },
      };
    }
    return { mount, TEMPLATE };
  })();

  return { FlowFmt: Fmt, FlowDerive, FlowSim, FlowLife, FlowUI };
});

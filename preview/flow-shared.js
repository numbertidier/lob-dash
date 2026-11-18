/*
 * flow-shared.js: one source of truth for the flow pages (Mac dash and phone).
 * Pure functions of FlowState (CONTRACT.md). No DOM, no globals touched except the UMD export.
 *
 *   Fmt     number and time formatting (3 significant figures for money)
 *   Derive  taker flow, the read, makers, net since open, window stats, folding and clustering
 *   Tokens  semantic colour roles per theme, plus the contrast and colour-blind checks they pass
 *
 * Browser: <script src="flow-shared.js"></script> then window.FlowShared.
 * Node:    const FlowShared = require("./flow-shared.js").
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FlowShared = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  /* ════════════════════════════════════════════════════════════════════════
     Constants. Change a rule here and both pages follow.
     ════════════════════════════════════════════════════════════════════════ */
  const RULES = Object.freeze({
    BUY_LEAD: 0.55,          // buy share at or above: buyers in control
    SELL_LEAD: 0.45,         // buy share at or below: sellers in control
    SPOT_QUIET_FRAC: 0.01,   // spot under 1% of perp volume: too thin to say it follows
    OI_FLAT_PCT: 0.03,       // |d5Pct| under this (percent units): OI flat
    HOT_X: 2,                // x usual at or above: hot
    QUIET_X: 0.5,            // x usual below: quiet, the read is weak
    READ_MIN_SEC: 30,        // seconds of data needed before a read is given
    BIG_USD: 1e6,            // big print
    HUGE_USD: 5e6,           // huge print, also an alert
    PUSH_MIN_Z: 2,           // pushes below this |z| are noise and not shown
    ALERT_PUSH_Z: 4,         // pushes at or above this |z| also raise an alert
    ALERT_HOT_REARM_X: 1.5,  // the hot alert re-arms once x usual drops below this
    WALL_FOLD_MS: 60e3,      // same venue, side, price and kind within this gap: one row
    PRINT_CLUSTER_MS: 250,   // same venue and side within this gap: one tape row
    MAKERS_SEC: 10,
    MAKERS_DEAD_SEC: 3,      // latest seconds all exactly zero: makers feed is dead
    FLOW_SEC: 60,
  });

  /* ════════════════════════════════════════════════════════════════════════
     Fmt
     ════════════════════════════════════════════════════════════════════════ */
  const MINUS = "−";
  const UNITS = [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "k"]];

  /** Round to 3 significant figures and return the digits as a string ("8.77", "327", "1.10"). */
  function sig3(a) {
    if (a === 0) return "0";
    const digits = Math.floor(Math.log10(a)) + 1;
    let out = a.toFixed(Math.max(0, 3 - digits));
    const after = Math.floor(Math.log10(+out)) + 1;          // 9.996 rounds to 10.00: one figure too many
    if (after !== digits) out = (+out).toFixed(Math.max(0, 3 - after));
    return out;
  }

  const Fmt = {
    MINUS,
    /**
     * Money, 3 significant figures: $8.77M, $327k, $26.4B, $1.10M, $842.
     * @param {number} v USD
     * @param {{sign?: boolean}} [o] sign: prefix + on positives
     */
    usd(v, o) {
      if (v == null || !Number.isFinite(v)) return "—";
      const a = Math.abs(v);
      let body;
      if (a < 999.5) body = a < 1 ? "0" : String(Math.round(a));
      else {
        let k = UNITS.findIndex(([d]) => a >= d * 0.9995);
        let s = sig3(a / UNITS[k][0]);
        if (+s >= 1000 && k > 0) { k -= 1; s = sig3(a / UNITS[k][0]); }   // $999.7k rounds to $1.00M
        body = s + UNITS[k][1];
      }
      if (body === "0") return "$0";
      const pre = v < 0 ? MINUS : o && o.sign && v > 0 ? "+" : "";
      return pre + "$" + body;
    },
    /** Signed money with a direction glyph: "▲ +$1.20M", "▼ −$9.81M", "$0". */
    signedUsd(v) {
      if (v == null || !Number.isFinite(v)) return "—";
      if (Math.abs(v) < 0.5) return "$0";
      return (v > 0 ? "▲ " : "▼ ") + Fmt.usd(v, { sign: true });
    },
    /** Price with thousands commas and 1 decimal (dp to override): 65,469.4. */
    px(v, dp = 1) {
      if (v == null || !Number.isFinite(v)) return "—";
      const neg = v < 0, s = Math.abs(v).toFixed(dp), [i, f] = s.split(".");
      return (neg ? MINUS : "") + i.replace(/\B(?=(\d{3})+(?!\d))/g, ",") + (f ? "." + f : "");
    },
    /** Signed price move with glyph: "▼ −378.2". */
    signedPx(v, dp = 1) {
      if (v == null || !Number.isFinite(v)) return "—";
      if (Math.abs(v) < 0.5 * 10 ** -dp) return Fmt.px(0, dp);
      return (v > 0 ? "▲ +" : "▼ ") + Fmt.px(v, dp);
    },
    /** Percent: "−0.57%". sign adds + on positives. Input is already in percent. */
    pct(v, dp = 2, sign = true) {
      if (v == null || !Number.isFinite(v)) return "—";
      const r = v.toFixed(dp), zero = +r === 0;
      return (v < 0 && !zero ? MINUS : sign && v > 0 && !zero ? "+" : "") + Math.abs(v).toFixed(dp) + "%";
    },
    /** Share 0..1 as whole percent: "72%". */
    share(v) { return v == null ? "—" : Math.round(v * 100) + "%"; },
    /** Multiple, 3 significant figures: "2.53×", "6.10×", "12.4×". */
    times(v) { return v == null || !Number.isFinite(v) ? "—" : sig3(Math.abs(v)) + "×"; },
    /** z score: "z 4.4" (one decimal, absolute). */
    z(v) { return v == null ? "—" : "z " + Math.abs(v).toFixed(1); },
    /** UTC clock "18:54:08". */
    hms(t) { return new Date(t).toISOString().slice(11, 19); },
    /** UTC clock "18:54". */
    hm(t) { return new Date(t).toISOString().slice(11, 16); },
    /** Duration "2:31". */
    dur(ms) { const s = Math.max(0, Math.round(ms / 1000)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); },
    /** Short age "4s", "2m 10s". */
    age(ms) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? s + "s" : Math.floor(s / 60) + "m " + (s % 60) + "s"; },
  };

  /* ════════════════════════════════════════════════════════════════════════
     Derive
     ════════════════════════════════════════════════════════════════════════ */
  const SUM_KEYS = ["perpBuy", "perpSell", "spotBuy", "spotSell"];
  const MAKER_KEYS = ["bidAdded", "bidPulled", "askAdded", "askPulled"];
  const prepCache = typeof WeakMap !== "undefined" ? new WeakMap() : null;

  /** Prefix sums over state.seconds so range sums are O(1). Cached per state object. */
  function prep(state) {
    const hit = prepCache && prepCache.get(state);
    if (hit) return hit;
    const secs = state.seconds || [], n = secs.length, sum = {};
    for (const k of SUM_KEYS.concat(MAKER_KEYS, ["makerRows"])) sum[k] = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      const s = secs[i];
      for (const k of SUM_KEYS) sum[k][i + 1] = sum[k][i] + (s[k] || 0);
      for (const k of MAKER_KEYS) sum[k][i + 1] = sum[k][i] + (s.makers ? s.makers[k] || 0 : 0);
      sum.makerRows[i + 1] = sum.makerRows[i] + (s.makers ? 1 : 0);
    }
    const p = { n, sum };
    if (prepCache) prepCache.set(state, p);
    return p;
  }
  /** Sum of key over seconds i0..i1 inclusive, clamped. */
  function rangeSum(p, key, i0, i1) {
    i0 = Math.max(0, i0); i1 = Math.min(p.n - 1, i1);
    return i1 < i0 ? 0 : p.sum[key][i1 + 1] - p.sum[key][i0];
  }
  /** Last index whose second is complete at or before t, -1 if none. */
  function lastIndexBy(secs, t) {
    let lo = 0, hi = secs.length - 1, ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (secs[m].t + 1000 <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  /** First index with t >= t0. */
  function firstIndexFrom(secs, t0) {
    let lo = 0, hi = secs.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (secs[m].t < t0) lo = m + 1; else hi = m; }
    return lo;
  }
  /** Resolve the end index: explicit, or the last second. */
  function endOf(state, endIdx) { const n = (state.seconds || []).length; return endIdx == null ? n - 1 : Math.min(endIdx, n - 1); }
  /** End time (ms, exclusive) of second index i. */
  function endTime(state, i) { return i >= 0 ? state.seconds[i].t + 1000 : state.now; }

  /** Verdict from perp buy share. key: buyers | sellers | balanced | none. */
  function verdict(buyShare) {
    if (buyShare == null) return { key: "none", label: "No read yet", glyph: "…" };
    if (buyShare >= RULES.BUY_LEAD) return { key: "buyers", label: "Buyers in control", lean: "Buyers lean", glyph: "▲" };
    if (buyShare <= RULES.SELL_LEAD) return { key: "sellers", label: "Sellers in control", lean: "Sellers lean", glyph: "▼" };
    return { key: "balanced", label: "Balanced", lean: "Balanced", glyph: "◆" };
  }

  /**
   * Taker flow over the last minute. Headline is perps only (x usual is perps only); spot kept apart.
   * @returns {{perp:{buy,sell,total,buyShare}, spot:{buy,sell,total,buyShare}, xUsual, hot, quiet, haveSec, endIdx}}
   */
  function taker1m(state, endIdx) {
    const p = prep(state), e = endOf(state, endIdx), i0 = e - RULES.FLOW_SEC + 1;
    const side = (b, s) => ({ buy: b, sell: s, total: b + s, buyShare: b + s > 0 ? b / (b + s) : null });
    const perp = side(rangeSum(p, "perpBuy", i0, e), rangeSum(p, "perpSell", i0, e));
    const spot = side(rangeSum(p, "spotBuy", i0, e), rangeSum(p, "spotSell", i0, e));
    const usual = state.usual && state.usual.vol1m;
    const xUsual = usual > 0 ? perp.total / usual : null;
    return { perp, spot, xUsual, hot: xUsual != null && xUsual >= RULES.HOT_X, quiet: xUsual != null && xUsual < RULES.QUIET_X,
             haveSec: Math.max(0, Math.min(RULES.FLOW_SEC, e + 1)), endIdx: e };
  }

  /** Spot vs perp leader, same 55/45 rule. follows | not following | other way | quiet | null. */
  function spotRead(perpKey, spot, perpTotal) {
    if (perpKey !== "buyers" && perpKey !== "sellers") return null;
    if (spot.total < RULES.SPOT_QUIET_FRAC * perpTotal || spot.buyShare == null) return "quiet";
    const s = verdict(spot.buyShare).key;
    if (s === perpKey) return "follows";
    return s === "balanced" ? "not following" : "other way";
  }

  /** OI over 5 min: rising | flat | falling | null. */
  function oiRead(oi) {
    if (!oi || oi.d5Pct == null) return null;
    return Math.abs(oi.d5Pct) < RULES.OI_FLAT_PCT ? "flat" : oi.d5Pct > 0 ? "rising" : "falling";
  }
  const OI_WHY = { "buyers rising": "new longs", "buyers falling": "shorts covering", "sellers rising": "new shorts", "sellers falling": "longs closing" };

  /**
   * The read: verdict and one plain sentence, quoting the leading side's share.
   * e.g. "Perps 75% selling. Spot follows. OI falling: longs closing."
   * @param {object} state FlowState
   * @param {{endIdx?: number, oi?: 'include'|'tag'|'omit'}} [o] oi: in replay, 'tag' adds "(OI live)", 'omit' drops the clause
   */
  function read(state, o) {
    o = o || {};
    const f = taker1m(state, o.endIdx), v = verdict(f.haveSec >= RULES.READ_MIN_SEC ? f.perp.buyShare : null);
    if (v.key === "none") return { verdict: v, weak: false, parts: [], sentence: "Need 30 seconds of trades for a read.", flow: f };
    const sellShare = 1 - f.perp.buyShare;
    const leadSelling = v.key === "sellers" || (v.key === "balanced" && sellShare > f.perp.buyShare);
    const parts = [{ key: "perp", text: `Perps ${Math.round((leadSelling ? sellShare : f.perp.buyShare) * 100)}% ${leadSelling ? "selling" : "buying"}.` }];
    const spot = spotRead(v.key, f.spot, f.perp.total);
    if (spot === "follows") parts.push({ key: "spot", text: "Spot follows." });
    else if (spot === "not following") parts.push({ key: "spot", text: "Spot not following." });
    else if (spot === "other way") parts.push({ key: "spot", text: "Spot going the other way." });
    else if (spot === "quiet") parts.push({ key: "spot", text: "Spot too thin to say." });
    const oi = oiRead(state.oi), mode = o.oi || "include";
    if (oi && mode !== "omit") {
      const why = OI_WHY[v.key + " " + oi];
      parts.push({ key: "oi", text: `OI ${oi}${why ? ": " + why : ""}.${mode === "tag" ? " (OI live)" : ""}` });
    }
    const weak = f.quiet;
    if (weak) parts.push({ key: "weak", text: "Quiet market, read is weak." });
    return { verdict: v, label: weak ? v.lean : v.label, weak, spot, oi, parts, sentence: parts.map(x => x.text).join(" "), flow: f };
  }

  /**
   * Makers over 10 s. net = pulled − added per side (positive = liquidity leaving).
   * No data when the engine flags it (state.makersOk === false), when no second carries makers, or when the
   * latest MAKERS_DEAD_SEC seconds are all exactly zero. Four live books never net to exactly 0 for 3 s; a dead feed does.
   */
  function makers10s(state, endIdx) {
    const p = prep(state), e = endOf(state, endIdx), i0 = e - RULES.MAKERS_SEC + 1;
    const g = k => rangeSum(p, k, i0, e);
    const raw = { bidAdded: g("bidAdded"), bidPulled: g("bidPulled"), askAdded: g("askAdded"), askPulled: g("askPulled") };
    const d0 = e - RULES.MAKERS_DEAD_SEC + 1, deadSum = MAKER_KEYS.reduce((a, k) => a + rangeSum(p, k, d0, e), 0);
    const none = state.makersOk === false || g("makerRows") === 0 || deadSum === 0;
    if (none) return { ok: false, bid: null, ask: null, verdict: "No maker data", raw };
    const bid = raw.bidPulled - raw.bidAdded, ask = raw.askPulled - raw.askAdded;
    let verdictText;
    if (bid > 0 && ask > 0) verdictText = "Both sides pulling";
    else if (bid < 0 && ask < 0) verdictText = "Both sides adding";
    else if (bid > 0) verdictText = "Bids thinning";
    else if (ask > 0) verdictText = "Asks thinning";
    else if (bid < 0) verdictText = "Bids building";
    else if (ask < 0) verdictText = "Asks building";
    else verdictText = "Steady";
    const word = v => v > 0 ? "pulling" : v < 0 ? "adding" : "steady";
    return { ok: true, bid, ask, bidWord: word(bid), askWord: word(ask), verdict: verdictText, raw };
  }

  /** Window bounds for windowMs ending at endIdx: seconds [i0, e], time [t0, t1). */
  function windowBounds(state, windowMs, endIdx) {
    const secs = state.seconds || [], e = endOf(state, endIdx), t1 = endTime(state, e), t0 = t1 - windowMs;
    const i0 = firstIndexFrom(secs, t0);
    const first = secs.length ? secs[0].t : t1;
    return { i0, e, t0, t1, haveMs: Math.min(windowMs, t1 - first), partial: first > t0, startT: Math.max(first, t0) };
  }

  /** Net taker flow since the window opened, perps and spot apart. Same numbers for tile and chart. */
  function netSinceOpen(state, windowMs, endIdx) {
    const p = prep(state), w = windowBounds(state, windowMs, endIdx);
    const perp = rangeSum(p, "perpBuy", w.i0, w.e) - rangeSum(p, "perpSell", w.i0, w.e);
    const spot = rangeSum(p, "spotBuy", w.i0, w.e) - rangeSum(p, "spotSell", w.i0, w.e);
    return { perp, spot, ...w };
  }

  /** Cumulative net per second from the window start: arrays aligned to seconds[i0..e]. Last value equals netSinceOpen. */
  function netSeries(state, windowMs, endIdx) {
    const w = windowBounds(state, windowMs, endIdx), secs = state.seconds, perp = [], spot = [], t = [];
    let cp = 0, cs = 0;
    for (let i = w.i0; i <= w.e; i++) { const s = secs[i]; cp += s.perpBuy - s.perpSell; cs += s.spotBuy - s.spotSell; perp.push(cp); spot.push(cs); t.push(s.t); }
    return { t, perp, spot, ...w };
  }

  /** Prints inside [t0, t1). */
  function printsIn(state, t0, t1) { return (state.prints || []).filter(q => q.t >= t0 && q.t < t1); }

  /** Pushes worth showing: |z| >= PUSH_MIN_Z. */
  function filterPushes(pushes, minZ) {
    const z = minZ == null ? RULES.PUSH_MIN_Z : minZ;
    return (pushes || []).filter(q => Math.abs(q.z) >= z);
  }

  /** This-window stats: perp bought/sold, biggest print, prints >= $1M and >= $100k, sweeps and pushes (|z| >= 2). */
  function windowStats(state, windowMs, endIdx) {
    const p = prep(state), w = windowBounds(state, windowMs, endIdx), inWin = printsIn(state, w.t0, w.t1);
    let biggest = null;
    for (const q of inWin) if (!biggest || q.usd > biggest.usd) biggest = q;
    let biggestOrder = null;  // the tape's unit: fills clustered by venue+side (count > 1 = several fills)
    for (const c of clusterPrints(inWin)) if (!biggestOrder || c.usd > biggestOrder.usd) biggestOrder = c;
    const pushes = filterPushes(state.pushes).filter(q => q.t >= w.t0 && q.t < w.t1);
    return {
      perpBought: rangeSum(p, "perpBuy", w.i0, w.e), perpSold: rangeSum(p, "perpSell", w.i0, w.e), biggest, biggestOrder,
      prints: inWin.length, prints1m: inWin.filter(q => q.usd >= RULES.BIG_USD).length,
      sweeps: pushes.filter(q => q.kind === "sweep").length, pushes: pushes.length, ...w,
    };
  }

  /**
   * Fold wall events: same venue, side, price and kind, each within WALL_FOLD_MS of the previous one,
   * become one row with a count. Kind stays in the key: "pulled" and "eaten" at one price are different facts.
   * @returns {{id, kind, side, px, venue, usd, count, firstT, t, ids}[]} oldest first; t = latest event
   */
  function foldWalls(walls, foldMs) {
    const gap = foldMs == null ? RULES.WALL_FOLD_MS : foldMs, open = new Map(), out = [];
    for (const w of (walls || []).slice().sort((a, b) => a.t - b.t)) {
      const key = [w.venue, w.side, w.px, w.kind].join("|"), row = open.get(key);
      if (row && w.t - row.t <= gap) { row.count++; row.t = w.t; row.usd = Math.max(row.usd, w.usd); row.ids.push(w.id); continue; }
      const fresh = { id: "w" + w.id, kind: w.kind, side: w.side, px: w.px, venue: w.venue, usd: w.usd, count: 1, firstT: w.t, t: w.t, ids: [w.id] };
      open.set(key, fresh); out.push(fresh);
    }
    return out.sort((a, b) => a.t - b.t);
  }

  /**
   * Cluster prints for the tape: same venue and side, each within PRINT_CLUSTER_MS of the previous one.
   * Raw prints stay untouched for the chart.
   * @returns {{id, venue, kind, side, t, tLast, usd, count, pxFirst, pxLast, biggest, ids}[]} oldest first
   */
  function clusterPrints(prints, gapMs) {
    const gap = gapMs == null ? RULES.PRINT_CLUSTER_MS : gapMs, open = new Map(), out = [];
    for (const q of (prints || []).slice().sort((a, b) => a.t - b.t)) {
      const key = q.venue + "|" + q.side, c = open.get(key);
      if (c && q.t - c.tLast <= gap) {
        c.count++; c.tLast = q.t; c.usd += q.usd; c.pxLast = q.px; c.biggest = Math.max(c.biggest, q.usd); c.ids.push(q.id); continue;
      }
      const fresh = { id: "c" + q.id, venue: q.venue, kind: q.kind, side: q.side, t: q.t, tLast: q.t, usd: q.usd, count: 1, pxFirst: q.px, pxLast: q.px, biggest: q.usd, ids: [q.id] };
      open.set(key, fresh); out.push(fresh);
    }
    return out;
  }

  /**
   * Alerts, deterministic over history (replay shows what live showed). Each alert names its source row
   * so a UI can flag that row instead of adding a duplicate. Standalone alerts (hot) have source null.
   * @returns {{id, t, text, sub, source: {type: 'print'|'wall'|'push', id}|null}[]} oldest first
   */
  function alerts(state) {
    const out = [], secs = state.seconds || [], usual = state.usual && state.usual.vol1m, p = prep(state);
    if (usual > 0) {
      let inHot = false;
      for (let i = RULES.FLOW_SEC - 1; i < secs.length; i++) {
        const i0 = i - RULES.FLOW_SEC + 1, x = (rangeSum(p, "perpBuy", i0, i) + rangeSum(p, "perpSell", i0, i)) / usual;
        if (!inHot && x >= RULES.HOT_X) { inHot = true; out.push({ id: "hot" + secs[i].t, t: secs[i].t + 1000, text: `Flow ${Fmt.times(x)} usual`, sub: "perp taker volume, last minute", source: null }); }
        else if (inHot && x < RULES.ALERT_HOT_REARM_X) inHot = false;
      }
    }
    for (const q of state.prints || []) if (q.usd >= RULES.HUGE_USD)
      out.push({ id: "pr" + q.id, t: q.t, text: `${q.side === "buy" ? "▲ Buy" : "▼ Sell"} print ${Fmt.usd(q.usd)}`, sub: `${q.venue} at ${Fmt.px(q.px)}`, source: { type: "print", id: q.id } });
    for (const w of state.walls || []) if (w.kind === "eaten")
      out.push({ id: "we" + w.id, t: w.t, text: `${w.side === "bid" ? "Bid" : "Ask"} wall eaten`, sub: `${Fmt.usd(w.usd)} at ${Fmt.px(w.px, 0)}, ${w.venue}`, source: { type: "wall", id: w.id } });
    for (const q of state.pushes || []) if (Math.abs(q.z) >= RULES.ALERT_PUSH_Z)
      out.push({ id: "pu" + q.id, t: q.t, text: `${q.side === "buy" ? "▲ Buy" : "▼ Sell"} ${q.kind} ${Fmt.usd(q.usd)}`, sub: `${q.venue}, ${Fmt.z(q.z)}`, source: { type: "push", id: q.id } });
    return out.sort((a, b) => a.t - b.t);
  }

  /**
   * Event feed rows: folded walls + pushes (|z| >= 2) + standalone alerts, newest first, up to tEnd.
   * Alerts tied to a wall or push set row.alert on that row instead of adding a row.
   * @param {{tEnd?: number, filter?: 'all'|'wall'|'push'|'alert', extraAlerts?: object[], limit?: number}} [o]
   */
  function events(state, o) {
    o = o || {};
    const tEnd = o.tEnd == null ? Infinity : o.tEnd, filter = o.filter || "all";
    const al = alerts(state).concat(o.extraAlerts || []).filter(a => a.t < tEnd);
    const byWall = new Map(), byPush = new Map();
    for (const a of al) if (a.source && a.source.type === "wall") byWall.set(String(a.source.id), a); else if (a.source && a.source.type === "push") byPush.set(String(a.source.id), a);
    const rows = [];
    for (const w of foldWalls((state.walls || []).filter(x => x.t < tEnd)))
      rows.push({ type: "wall", t: w.t, wall: w, alert: w.ids.map(String).map(id => byWall.get(id)).find(Boolean) || null });
    for (const q of filterPushes(state.pushes).filter(x => x.t < tEnd))
      rows.push({ type: "push", t: q.t, push: q, alert: byPush.get(String(q.id)) || null });
    for (const a of al) if (!a.source || a.source.type === "print") rows.push({ type: "alert", t: a.t, alertRow: a, alert: a });
    const keep = r => filter === "all" || (filter === "alert" ? !!r.alert : r.type === filter);
    const out = rows.filter(keep).sort((a, b) => b.t - a.t);
    return o.limit ? out.slice(0, o.limit) : out;
  }

  /** Venues not live (down / connecting / blocked) and the honest caveat line. */
  function venueHealth(state) {
    const vs = state.venues || [], by = k => vs.filter(v => v.status === k).map(v => v.name);
    const down = by("down").concat(by("connecting")), blocked = by("blocked");
    return { live: by("live").length, total: vs.length, down, blocked,
             caveat: down.length ? `${down.join(", ")} down, flow reads low` : null };
  }

  /** Nearest fuel cluster each side of price, with distance and book cover. */
  function nearestFuel(fuel, px) {
    if (!fuel || !fuel.levels || px == null) return { below: null, above: null };
    const dec = l => ({ ...l, distPct: (l.px - px) / px * 100 });
    const below = fuel.levels.filter(l => l.px < px).sort((a, b) => b.px - a.px)[0];
    const above = fuel.levels.filter(l => l.px > px).sort((a, b) => a.px - b.px)[0];
    return { below: below ? dec(below) : null, above: above ? dec(above) : null };
  }

  const Derive = {
    RULES, prep, rangeSum, lastIndexBy, firstIndexFrom, verdict, taker1m, spotRead, oiRead, read, makers10s,
    windowBounds, netSinceOpen, netSeries, printsIn, filterPushes, windowStats, foldWalls, clusterPrints, alerts, events,
    venueHealth, nearestFuel,
  };

  /* ════════════════════════════════════════════════════════════════════════
     Tokens: semantic roles. UIs map roles to CSS variables; they never pick raw colours.
     One entry a skin of the phone page: desk, day, mono, read, warm. buy/sell are the validated pair; fuel is neutral;
     alert/warn is the caution colour (stale and down use it, never the sell colour). Every entry passes the checks below.
     ════════════════════════════════════════════════════════════════════════ */
  const T = (o) => Object.freeze(o);
  const themes = {
    // Desk: the phone page's one UI (it says data-theme="terminal"). Same values as the desktop page's "desk" entry, so the
    // checks below cover it. Up is green and down is red, and always carries a sign or an arrow.
    desk: T({ mode: "dark", bg: "#000000", panel: "#000000", raise: "#0C0C0C", strip: "#191919", rule: "#505050", hair: "#232323",
      ink: "#FFFFFF", ink2: "#D7D7D7", muted: "#A5A5A5", faint: "#8C8C8C", label: "#FFA028",
      buy: "#50F06E", sell: "#FF3D58", flat: "#8C8C8C", fuel: "#D7D7D7", fuelWeak: "#A5A5A5", maker: "#D7D7D7",
      alert: "#FFE100", onAlert: "#000000", warn: "#FFE100", hatchSell: false, ok: "#FFFFFF" }),
    // Skins of Desk (the page says data-skin): the same roles in other colours. Values are the page's own skin tokens.
    // Mono and Read have no hue: sells are hatched and italic, and each keeps its sign or its arrow.
    day: T({ mode: "light", bg: "#FFFFFF", panel: "#FFFFFF", raise: "#F1F1F1", strip: "#E3E3E3", rule: "#8A8A8A", hair: "#DADADA",
      ink: "#000000", ink2: "#2A2A2A", muted: "#595959", faint: "#676767", label: "#A63C00",
      buy: "#00695C", sell: "#B5001C", flat: "#676767", fuel: "#2A2A2A", fuelWeak: "#595959", maker: "#2A2A2A",
      alert: "#8A6400", onAlert: "#FFFFFF", warn: "#8A6400", hatchSell: false, ok: "#000000" }),
    mono: T({ mode: "dark", bg: "#000000", panel: "#000000", raise: "#0C0C0C", strip: "#191919", rule: "#505050", hair: "#232323",
      ink: "#FFFFFF", ink2: "#D7D7D7", muted: "#8E8E8E", faint: "#7C7C7C", label: "#ABABAB",
      buy: "#FFFFFF", sell: "#BDBDBD", flat: "#7C7C7C", fuel: "#D7D7D7", fuelWeak: "#8E8E8E", maker: "#D7D7D7",
      alert: "#FFFFFF", onAlert: "#000000", warn: "#FFFFFF", hatchSell: true, sellStyle: "hatch", fuelStyle: "dots", noHue: true, ok: "#FFFFFF" }),
    read: T({ mode: "light", bg: "#E8E8E8", panel: "#E8E8E8", raise: "#DEDEDE", strip: "#D4D4D4", rule: "#8E8E8E", hair: "#D0D0D0",
      ink: "#1A1A1A", ink2: "#363636", muted: "#5A5A5A", faint: "#5A5A5A", label: "#505050",
      buy: "#1A1A1A", sell: "#4A4A4A", flat: "#5A5A5A", fuel: "#363636", fuelWeak: "#5A5A5A", maker: "#363636",
      alert: "#1A1A1A", onAlert: "#E8E8E8", warn: "#1A1A1A", hatchSell: true, sellStyle: "hatch", fuelStyle: "dots", noHue: true, ok: "#1A1A1A" }),
    warm: T({ mode: "dark", bg: "#000000", panel: "#000000", raise: "#110A04", strip: "#1C1108", rule: "#5A3A1E", hair: "#27180B",
      ink: "#FFD2A0", ink2: "#E0AC78", muted: "#B8875A", faint: "#A37445", label: "#FFA028",
      buy: "#FFE066", sell: "#FF5238", flat: "#A37445", fuel: "#E0AC78", fuelWeak: "#B8875A", maker: "#E0AC78",
      alert: "#FFC800", onAlert: "#000000", warn: "#FFC800", hatchSell: false, ok: "#FFD2A0" }),
  };
  /** Roles that are drawn as text and must reach 4.5:1 on bg and panel. */
  const TEXT_ROLES = ["ink", "ink2", "muted", "faint", "label", "buy", "sell", "alert", "warn", "fuel"];

  /* Colour maths for the checks (WCAG 2 contrast; Viénot/Brettel CVD simulation; OKLab ΔE×100). */
  const hex = h => { const n = parseInt(h.replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255].map(v => v / 255); };
  const lin = c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  const luminance = h => { const [r, g, b] = hex(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  /** WCAG contrast ratio between two hex colours. */
  function contrast(a, b) { const la = luminance(a), lb = luminance(b); return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05); }
  const CVD = {
    protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
    deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.011820, 0.042940, 0.968881]],
    tritan: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.303900]],
  };   // Machado et al. 2009, severity 1.0, linear RGB
  const oklab = ([r, g, b]) => {
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s, 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s];
  };
  const clamp01 = v => Math.min(1, Math.max(0, v));
  /** OKLab ΔE ×100 between two hex colours, optionally as seen with a colour-vision deficiency. */
  function deltaE(a, b, kind) {
    const sim = h => { const c = hex(h).map(lin); if (!kind) return c; const M = CVD[kind]; return M.map(row => clamp01(row[0] * c[0] + row[1] * c[1] + row[2] * c[2])); };
    const A = oklab(sim(a)), B = oklab(sim(b));
    return Math.hypot(A[0] - B[0], A[1] - B[1], A[2] - B[2]) * 100;
  }
  /** Run every check for a theme. Returns failures (empty = pass). */
  function checkTheme(name) {
    const t = themes[name], fails = [];
    for (const role of TEXT_ROLES) for (const surf of ["bg", "panel"]) {
      const c = contrast(t[role], t[surf]); if (c < 4.5) fails.push(`${name}: ${role} on ${surf} ${c.toFixed(2)}:1`);
    }
    const onA = contrast(t.onAlert, t.alert); if (onA < 4.5) fails.push(`${name}: onAlert on alert ${onA.toFixed(2)}:1`);
    const normal = deltaE(t.buy, t.sell); if (normal < 15) fails.push(`${name}: buy/sell normal ΔE ${normal.toFixed(1)}`);
    for (const k of ["protan", "deutan", "tritan"]) { const d = deltaE(t.buy, t.sell, k); if (d < 8) fails.push(`${name}: buy/sell ${k} ΔE ${d.toFixed(1)}`); }
    return fails;
  }
  const Tokens = { themes, TEXT_ROLES, contrast, deltaE, checkTheme,
    /** Theme by name, falling back to desk. */
    get(name) { return Object.hasOwn(themes, name) ? themes[name] : themes.desk; },
    /** CSS custom properties for a theme ("--buy: #3987e5; ..."). */
    css(name) { const t = Tokens.get(name); return Object.keys(t).filter(k => typeof t[k] === "string" && t[k][0] === "#").map(k => `--${k.replace(/[A-Z]/g, c => "-" + c.toLowerCase())}: ${t[k]};`).join(" "); },
  };

  return { VERSION: "1.0.0", RULES, Fmt, Derive, Tokens };
});

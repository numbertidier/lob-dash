/**
 * flow-engine.js: live BTC order-flow engine for the flow page (contract: ../CONTRACT.md, v1).
 *
 * Runs in a browser (iPhone Safari, desktop Chrome) or in node >= 22 (global WebSocket + fetch).
 * Reads public exchange websockets and REST, keeps one FlowState, publishes it about once a second.
 *
 * Sections:
 *   1. constants and venue list      7. fuel (liquidation cluster model, port of fuel.py)
 *   2. trade parsers                 8. open interest, usual volume, HL stops
 *   3. seconds, prints, sweeps       9. derive() helpers for the UI
 *   4. order books and ladder       10. websocket connection with backoff
 *   5. wall events                  11. feed specs (urls, subscriptions, pings)
 *   6. pushes                       12. the engine
 *
 * Usage (browser):  const eng = FlowEngine.createEngine({ phone: true }); eng.subscribe(render); eng.start();
 * Usage (node):     const { createEngine } = require("./flow-engine.js");
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.FlowEngine = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ───────────────────────────── 1. constants ─────────────────────────────

  const BIG_USD = 100_000;
  const Z_FLOOR = 2; // no push of any kind below this |z|
  const HUGE_USD = 1_000_000;
  const KEEP_SECONDS = 20 * 60;
  const PRINT_KEEP_MS = 20 * 60_000;
  const EVENT_KEEP_MS = 40 * 60_000;
  const HISTORY_KEEP_MS = 20 * 60_000;
  const MIN = 60_000;
  const HOUR = 3_600_000;

  /** Fixed venue order (same as the UI fixture). Lighter is geo-blocked: never connected. */
  const VENUES = [
    ["Hyperliquid", "perp"], ["Binance", "perp"], ["Bybit", "perp"], ["OKX", "perp"], ["Lighter", "perp"],
    ["Gate", "perp"], ["Bitget", "perp"], ["Aster", "perp"], ["Deribit", "perp"], ["Extended", "perp"],
    ["MEXC", "perp"], ["Pacifica", "perp"], ["KuCoin", "perp"],
    ["Binance spot", "spot"], ["Bybit spot", "spot"], ["OKX spot", "spot"], ["Coinbase", "spot"], ["Kraken", "spot"],
  ].map(([name, kind]) => ({ name, kind }));

  /** Instrument whose trades fill each venue's subscribed order book (for makers and walls). */
  const BOOK_INST = { Binance: "BTCUSDT", Bybit: "BTCUSDT", OKX: "BTC-USDT-SWAP", Hyperliquid: "BTC" };

  // Contract sizes, checked against venue REST 2026-11-14 (see liqfun_work/collector/RESULTS.md).
  const OKX_USDT_SWAP_BTC = 0.01;
  const OKX_USD_SWAP_USD = 100;
  const GATE_BTC = 0.0001;
  const MEXC_BTC = 0.0001;
  const KUCOIN_BTC = 0.001;
  const BINANCE_COINM_USD = 100;

  // ───────────────────────────── 2. trade parsers ─────────────────────────────
  // Each parser: (decoded message, receive ms) -> Trade[]. Non-trade messages give [].
  // Trade = { venue, inst, kind, ts, side: "buy"|"sell" (taker), px, usd, id, recv, user? }

  /** Build one normalised trade. */
  function mkTrade(venue, inst, kind, ts, side, px, usd, id, recv, user) {
    const t = { venue, inst, kind, ts, side, px, usd, id: String(id), recv };
    if (user) t.user = user;
    return t;
  }

  /** Attach a consecutive venue trade sequence (used to count missed trades). */
  function seqd(t, key, seq) { t.seqKey = key; t.seq = Number(seq); return t; }

  /**
   * Parse an RFC3339 UTC timestamp with any number of fractional digits to epoch ms.
   * @param {string} stamp e.g. "2026-11-14T19:38:59.269822411Z"
   * @returns {number}
   */
  function isoToMs(stamp) {
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d+))?Z?$/.exec(stamp);
    if (!m) throw new Error(`bad timestamp ${stamp}`);
    const ms = m[7] ? Number((m[7] + "00").slice(0, 3)) : 0;
    return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
  }

  /** Binance-style aggTrade parser (Binance USD-M, Binance spot, Aster). Combined-stream wrapper allowed. */
  function binanceAgg(venue, kind) {
    return (msg, recv) => {
      const d = msg && msg.stream && msg.data ? msg.data : msg;
      if (!d || d.e !== "aggTrade") return [];
      const px = +d.p;
      return [seqd(mkTrade(venue, d.s, kind, +d.T, d.m ? "sell" : "buy", px, px * +d.q, d.a, recv), `${venue}|${d.s}`, d.a)];
    };
  }

  const parsers = {
    binance: binanceAgg("Binance", "perp"),
    binanceSpot: binanceAgg("Binance spot", "spot"),
    aster: binanceAgg("Aster", "perp"),

    /** Binance coin-M raw @trade fills; 100 USD contracts. Used for both volume and prints. */
    binanceCoinm(msg, recv) {
      if (!msg || msg.e !== "trade") return [];
      return [seqd(mkTrade("Binance", msg.s, "perp", +msg.T, msg.m ? "sell" : "buy", +msg.p, +msg.q * BINANCE_COINM_USD, msg.t, recv), `Binance|${msg.s}`, msg.t)];
    },

    hyperliquid(msg, recv) {
      if (msg.channel !== "trades" || !Array.isArray(msg.data)) return [];
      return msg.data.map((t) => {
        const px = +t.px, side = t.side === "B" ? "buy" : "sell";
        const user = Array.isArray(t.users) ? (side === "buy" ? t.users[0] : t.users[1]) : undefined;
        return mkTrade("Hyperliquid", t.coin, "perp", +t.time, side, px, px * +t.sz, t.tid, recv, user);
      });
    },

    /** Bybit linear (BTCUSDT, BTCPERP: BTC-sized) and inverse (BTCUSD: USD-sized). */
    bybit(msg, recv) {
      if (!String(msg.topic || "").startsWith("publicTrade.")) return [];
      return msg.data.map((t) => {
        const px = +t.p, usd = t.s === "BTCUSD" ? +t.v : +t.v * px;
        return mkTrade("Bybit", t.s, "perp", +t.T, t.S === "Buy" ? "buy" : "sell", px, usd, t.i, recv);
      });
    },

    bybitSpot(msg, recv) {
      if (!String(msg.topic || "").startsWith("publicTrade.")) return [];
      return msg.data.map((t) => mkTrade("Bybit spot", t.s, "spot", +t.T, t.S === "Buy" ? "buy" : "sell", +t.p, +t.p * +t.v, t.i, recv));
    },

    /** OKX trades channel (already merged per taker order and price). Swaps -> OKX, BTC-USDT spot -> OKX spot. */
    okx(msg, recv) {
      if (!msg.arg || msg.arg.channel !== "trades" || !Array.isArray(msg.data)) return [];
      const out = [];
      for (const t of msg.data) {
        const px = +t.px, sz = +t.sz, side = t.side === "buy" ? "buy" : "sell";
        if (t.instId === "BTC-USDT-SWAP") out.push(mkTrade("OKX", t.instId, "perp", +t.ts, side, px, sz * OKX_USDT_SWAP_BTC * px, t.tradeId, recv));
        else if (t.instId === "BTC-USD-SWAP") out.push(mkTrade("OKX", t.instId, "perp", +t.ts, side, px, sz * OKX_USD_SWAP_USD, t.tradeId, recv));
        else if (t.instId === "BTC-USDT") out.push(mkTrade("OKX spot", t.instId, "spot", +t.ts, side, px, sz * px, t.tradeId, recv));
      }
      return out;
    },

    gate(msg, recv) {
      if (msg.channel !== "futures.trades" || msg.event !== "update" || !Array.isArray(msg.result)) return [];
      return msg.result.map((t) => {
        const px = +t.price, sz = +t.size;
        return seqd(mkTrade("Gate", t.contract, "perp", +t.create_time_ms, sz > 0 ? "buy" : "sell", px, Math.abs(sz) * GATE_BTC * px, t.id, recv), `Gate|${t.contract}`, t.id);
      });
    },

    /** Bitget USDT and USDC perps. "snapshot" actions are history on subscribe and are skipped. */
    bitget(msg, recv) {
      if (msg.action !== "update" || !msg.arg || !Array.isArray(msg.data)) return [];
      return msg.data.map((t) => mkTrade("Bitget", msg.arg.instId, "perp", +t.ts, t.side === "buy" ? "buy" : "sell", +t.price, +t.price * +t.size, t.tradeId, recv));
    },

    /** Deribit perpetuals only. Inverse amount is USD; USDC perp amount is BTC. */
    deribit(msg, recv) {
      const p = msg.params;
      if (!p || !String(p.channel || "").startsWith("trades.") || !Array.isArray(p.data)) return [];
      const out = [];
      for (const t of p.data) {
        if (!String(t.instrument_name).endsWith("PERPETUAL")) continue;
        const px = +t.price, usd = t.instrument_name.includes("USDC") ? +t.amount * px : +t.amount;
        const tr = mkTrade("Deribit", t.instrument_name, "perp", +t.timestamp, t.direction === "buy" ? "buy" : "sell", px, usd, t.trade_id, recv);
        out.push(t.trade_seq != null ? seqd(tr, `Deribit|${t.instrument_name}`, t.trade_seq) : tr);
      }
      return out;
    },

    /** Extended: seq 1 is the history snapshot sent on connect. */
    extended(msg, recv) {
      if (!Array.isArray(msg.data) || msg.seq === 1) return [];
      // ids exceed 2^53 and are rounded by JSON.parse; time, side, price and size keep them unique
      return msg.data.map((t) => mkTrade("Extended", t.m, "perp", +t.T, t.S === "BUY" ? "buy" : "sell", +t.p, +t.p * +t.q, `${t.i}-${t.T}-${t.S}-${t.p}-${t.q}`, recv));
    },

    mexc(msg, recv) {
      if (msg.channel !== "push.deal" || !msg.data) return [];
      const rows = Array.isArray(msg.data) ? msg.data : [msg.data];
      return rows.map((t) => mkTrade("MEXC", msg.symbol || "BTC_USDT", "perp", +t.t, +t.T === 1 ? "buy" : "sell", +t.p, +t.v * MEXC_BTC * +t.p, t.i ?? `${t.t}-${t.p}-${t.v}`, recv));
    },

    pacifica(msg, recv) {
      if (msg.channel !== "trades" || !Array.isArray(msg.data)) return [];
      return msg.data.map((t) => {
        const side = t.d === "open_long" || t.d === "close_short" ? "buy" : "sell";
        return mkTrade("Pacifica", t.s || "BTC", "perp", +t.t, side, +t.p, +t.p * +t.a, t.h ?? `${t.t}-${t.p}-${t.a}`, recv);
      });
    },

    kucoin(msg, recv) {
      if (msg.type !== "message" || !String(msg.topic || "").includes("execution") || !msg.data) return [];
      const t = msg.data, px = +t.price;
      return [mkTrade("KuCoin", t.symbol, "perp", Math.floor(+t.ts / 1e6), t.side === "buy" ? "buy" : "sell", px, +t.size * KUCOIN_BTC * px, t.tradeId, recv)];
    },

    /** Coinbase market_trades: "side" is the maker side, so the taker side is flipped. Snapshots skipped. */
    coinbase(msg, recv) {
      if (msg.channel !== "market_trades" || !Array.isArray(msg.events)) return [];
      const out = [];
      for (const ev of msg.events) {
        if (ev.type !== "update") continue;
        for (const t of ev.trades) out.push(mkTrade("Coinbase", t.product_id, "spot", isoToMs(t.time), t.side === "BUY" ? "sell" : "buy", +t.price, +t.price * +t.size, t.trade_id, recv));
      }
      return out;
    },

    kraken(msg, recv) {
      if (msg.channel !== "trade" || msg.type !== "update" || !Array.isArray(msg.data)) return [];
      return msg.data.map((t) => seqd(mkTrade("Kraken", t.symbol, "spot", isoToMs(t.timestamp), t.side === "buy" ? "buy" : "sell", +t.price, +t.price * +t.qty, t.trade_id, recv), `Kraken|${t.symbol}`, t.trade_id));
    },
  };

  // ───────────────────────────── 3. seconds, prints, sweeps ─────────────────────────────

  function emptyAcc() {
    return { perpBuy: 0, perpSell: 0, spotBuy: 0, spotSell: 0, byVenue: {}, bySize: { small: [0, 0], mid: [0, 0], large: [0, 0] }, binancePx: 0, perpPx: 0, anyPx: 0 };
  }

  /**
   * Per-second taker flow keyed on receive time (matches the reference, which buckets by its own receive time).
   * bySize classes are per trade message (the print unit), perps only.
   * px = last Binance BTCUSDT price in the second, else last perp, else last spot, else carried.
   * No rows are emitted before the first trade, so px is never 0.
   */
  class SecondsStore {
    /** @param {{keepSeconds?: number}} opts */
    constructor({ keepSeconds = KEEP_SECONDS } = {}) {
      this.keep = keepSeconds;
      this.open = new Map();
      this.closed = [];
      this.lastClosed = null;
      this.lastPx = 0;
      this.late = 0;
    }

    /** Add one trade to its receive second. Trades for an already closed second are counted in `late`. */
    add(trade) {
      const sec = Math.floor(trade.recv / 1000);
      if (this.lastClosed !== null && sec <= this.lastClosed) { this.late++; return; }
      let acc = this.open.get(sec);
      if (!acc) { acc = emptyAcc(); this.open.set(sec, acc); }
      const buy = trade.side === "buy";
      acc.anyPx = trade.px;
      const pair = acc.byVenue[trade.venue] || (acc.byVenue[trade.venue] = [0, 0]);
      pair[buy ? 0 : 1] += trade.usd;
      if (trade.kind === "perp") {
        if (buy) acc.perpBuy += trade.usd; else acc.perpSell += trade.usd;
        const cls = trade.usd >= HUGE_USD ? "large" : trade.usd >= BIG_USD ? "mid" : "small";
        acc.bySize[cls][buy ? 0 : 1] += trade.usd;
        if (trade.venue === "Binance" && trade.inst === "BTCUSDT") acc.binancePx = trade.px;
        acc.perpPx = trade.px;
      } else if (buy) acc.spotBuy += trade.usd; else acc.spotSell += trade.usd;
    }

    /**
     * Close every second up to and including `sec` (gaps become zero rows with the carried price).
     * @returns {object[]} the rows closed by this call, oldest first
     */
    finalizeThrough(sec) {
      let start = this.lastClosed === null ? Math.min(sec, ...this.open.keys()) : this.lastClosed + 1;
      start = Math.max(start, sec - this.keep + 1);
      for (const s of [...this.open.keys()].filter((k) => k < start).sort((x, y) => x - y)) {
        const acc = this.open.get(s); // seconds too old to keep still carry their price forward
        this.lastPx = acc.binancePx || acc.perpPx || acc.anyPx || this.lastPx;
      }
      const out = [];
      for (let s = start; s <= sec; s++) {
        const acc = this.open.get(s) || emptyAcc();
        this.open.delete(s);
        this.lastPx = acc.binancePx || acc.perpPx || acc.anyPx || this.lastPx;
        if (!this.lastPx) continue; // no price known yet: emit nothing rather than px 0
        const row = { t: s * 1000, px: this.lastPx, perpBuy: acc.perpBuy, perpSell: acc.perpSell, spotBuy: acc.spotBuy, spotSell: acc.spotSell, byVenue: acc.byVenue, bySize: acc.bySize };
        if (this.gapNext) { row.gap = true; this.gapNext = false; }
        out.push(row);
      }
      for (const s of this.open.keys()) if (s <= sec) this.open.delete(s);
      this.lastClosed = Math.max(this.lastClosed ?? sec, sec);
      this.closed.push(...out);
      if (this.closed.length > this.keep) this.closed.splice(0, this.closed.length - this.keep);
      return out;
    }

    /**
     * Mark everything up to `sec` as missing (engine was stopped): no rows are emitted for it and the
     * next row carries gap: true so charts can draw a break.
     */
    skipTo(sec) {
      for (const s of this.open.keys()) if (s <= sec) this.open.delete(s);
      this.lastClosed = Math.max(this.lastClosed ?? sec, sec);
      this.gapNext = true;
    }

    /** Closed rows, oldest first (internal array; copy before handing out). */
    rows() { return this.closed; }
  }

  /**
   * Drops repeated trades (same venue + instrument + id), e.g. after a reconnect. Bounded memory.
   * Oldest keys are evicted through a ring buffer: O(1). (Evicting via Set.values().next() is O(holes) in V8
   * and made this 89% of engine CPU under burst load, stalling the page for over a second.)
   */
  class Deduper {
    constructor(capacity = 50_000) { this.capacity = capacity; this.keys = new Set(); this.ring = new Array(capacity); this.head = 0; }

    /** @returns {boolean} true if this trade was seen before */
    seen(trade) {
      const key = `${trade.venue}|${trade.inst}|${trade.id}`;
      if (this.keys.has(key)) return true;
      const old = this.ring[this.head];
      if (old !== undefined) this.keys.delete(old);
      this.ring[this.head] = key;
      this.head = (this.head + 1) % this.capacity;
      this.keys.add(key);
      return false;
    }
  }

  /** Prints: each venue trade message >= bigUsd as is (no extra merging), stamped with receive time. */
  class PrintTape {
    constructor({ keepMs = PRINT_KEEP_MS, bigUsd = BIG_USD } = {}) { this.keepMs = keepMs; this.bigUsd = bigUsd; this.items = []; }

    /** Add a trade if it is big enough. */
    add(trade) {
      if (trade.usd < this.bigUsd) return;
      const p = { id: `${trade.venue}:${trade.inst}:${trade.id}`, t: trade.recv, venue: trade.venue, kind: trade.kind, side: trade.side, usd: trade.usd, px: trade.px };
      if (trade.user) p.wallet = trade.user;
      this.items.push(p);
    }

    /** Drop prints older than keepMs. */
    prune(now) {
      let i = 0;
      while (i < this.items.length && this.items[i].t < now - this.keepMs) i++;
      if (i) this.items.splice(0, i);
    }

    list() { return this.items; }
  }

  /**
   * Sweeps (our rule): perp trades on one venue and side whose exchange timestamps fall within windowMs
   * (250 ms) of the first one form one group (one aggressive taker as far as public data shows).
   * A group is a sweep if it fills >= minLevels (3) distinct prices for >= minLevelUsd ($250K),
   * or >= bigUsd ($1M) at any number of prices. Groups close when their first second is finalized.
   */
  class SweepDetector {
    constructor({ windowMs = 250, minLevels = 3, minLevelUsd = 250_000, bigUsd = 1_000_000 } = {}) {
      Object.assign(this, { windowMs, minLevels, minLevelUsd, bigUsd });
      this.open = new Map(); this.closed = [];
    }

    add(trade) {
      if (trade.kind !== "perp") return;
      const key = `${trade.venue}|${trade.side}`;
      let g = this.open.get(key);
      if (g && Math.abs(trade.ts - g.ts0) > this.windowMs) { this.closed.push(g); g = null; }
      if (!g) { g = { venue: trade.venue, side: trade.side, ts0: trade.ts, sec: Math.floor(trade.recv / 1000), t: trade.recv, prices: new Set(), usd: 0, px: 0 }; this.open.set(key, g); }
      g.prices.add(trade.px);
      g.usd += trade.usd;
      g.px = trade.px;
    }

    isSweep(g) { return g.usd >= this.bigUsd || (g.prices.size >= this.minLevels && g.usd >= this.minLevelUsd); }

    /** @returns {{t:number, venue:string, side:string, usd:number, levels:number, px:number, sec:number}[]} sweeps first seen in seconds <= sec */
    finalizeThrough(sec) {
      for (const [key, g] of this.open) if (g.sec <= sec) { this.closed.push(g); this.open.delete(key); }
      const out = [], keep = [];
      for (const g of this.closed) {
        if (g.sec > sec) { keep.push(g); continue; }
        if (this.isSweep(g)) out.push({ t: g.t, sec: g.sec, venue: g.venue, side: g.side, usd: g.usd, levels: g.prices.size, px: g.px });
      }
      this.closed = keep;
      return out;
    }
  }

  /**
   * Missed trades: venues whose trade ids are consecutive (Gate, Binance aggTrade and coin-M fills, Aster,
   * Deribit trade_seq, Kraken) let us count trades the stream never delivered. Repeats and out-of-order ids
   * are ignored; after a reconnect counting restarts. Counts are kept for 10 minutes.
   */
  class SeqGaps {
    constructor({ keepMs = 10 * MIN } = {}) { this.keepMs = keepMs; this.last = new Map(); this.events = new Map(); }

    add(t) {
      if (t.seq == null || !Number.isFinite(t.seq)) return;
      const last = this.last.get(t.seqKey);
      if (last != null && t.seq > last + 1) {
        const ev = this.events.get(t.venue) || [];
        ev.push([t.recv, t.seq - last - 1]);
        this.events.set(t.venue, ev);
      }
      if (last == null || t.seq > last) this.last.set(t.seqKey, t.seq);
    }

    /** Forget the last id of every sequence of a venue (its socket reconnected). */
    reset(venue) { for (const k of this.last.keys()) if (k.startsWith(`${venue}|`)) this.last.delete(k); }

    missed(venue, now) {
      const ev = (this.events.get(venue) || []).filter(([t]) => t >= now - this.keepMs);
      this.events.set(venue, ev);
      return ev.reduce((a, [, n]) => a + n, 0);
    }

    /** {venue: missed trades in the last 10 min} for venues with any. */
    all(now) {
      const out = {};
      for (const v of this.events.keys()) { const n = this.missed(v, now); if (n) out[v] = n; }
      return out;
    }
  }

  // ───────────────────────────── 4. order books ─────────────────────────────

  /** One venue's price levels. Sizes in BTC; USD = size * price. */
  class L2Book {
    constructor(venue) { this.venue = venue; this.bids = new Map(); this.asks = new Map(); this.ready = false; this.reach = null; }

    side(side) { return side === "bid" ? this.bids : this.asks; }

    /** Set a level (size 0 deletes). @returns {number} the old size */
    set(side, px, size) {
      const m = this.side(side), old = m.get(px) || 0;
      if (size > 0) m.set(px, size); else m.delete(px);
      return old;
    }

    clear() { this.bids.clear(); this.asks.clear(); this.reach = null; }

    bestBid() { let b = -Infinity; for (const p of this.bids.keys()) if (p > b) b = p; return b; }
    bestAsk() { let a = Infinity; for (const p of this.asks.keys()) if (p < a) a = p; return a; }
    mid() { return (this.bestBid() + this.bestAsk()) / 2; }

    /**
     * How far from `ref` this book is known to be complete on one side. A truncated (top-N) book only
     * knows levels up to its deepest one; Binance uses the reach of its REST snapshot.
     */
    coverage(side, ref = this.mid()) {
      if (this.reach && this.reach[side] != null) return Math.abs(this.reach[side] - ref);
      const m = this.side(side);
      if (!m.size) return 0;
      let deep = side === "bid" ? Infinity : -Infinity;
      for (const p of m.keys()) deep = side === "bid" ? Math.min(deep, p) : Math.max(deep, p);
      return Math.abs(deep - ref);
    }

    /** Drop levels outside [lo, hi] (bounds memory for diff-stream books). */
    prune(lo, hi) {
      for (const m of [this.bids, this.asks]) for (const p of m.keys()) if (p < lo || p > hi) m.delete(p);
    }
  }

  /** Shared plumbing for venue book adapters: apply [px, size] rows and report changes. */
  class BookAdapter {
    constructor({ venue, onLevel = () => {}, scale = 1 }) { this.venue = venue; this.book = new L2Book(venue); this.onLevel = onLevel; this.scale = scale; }
    get ready() { return this.book.ready; }
    set ready(v) { this.book.ready = v; }
    reset() { this.book.clear(); this.ready = false; }
    applyRows(side, rows, recv, report) {
      for (const r of rows) {
        const px = +r[0], size = +r[1] * this.scale;
        const old = this.book.set(side, px, size);
        if (report && old !== size) this.onLevel(this.venue, side, px, old, size, recv);
      }
    }
  }

  /** Bybit orderbook.{depth}.{symbol}: snapshot then deltas, size 0 deletes. */
  class BybitBook extends BookAdapter {
    constructor(opts) { super(opts); this.symbol = opts.symbol; }
    /** @returns {boolean} true if the message was for this book */
    handle(msg, recv) {
      const topic = String(msg.topic || "");
      if (!topic.startsWith("orderbook.") || !topic.endsWith(`.${this.symbol}`)) return false;
      const d = msg.data;
      const snapshot = msg.type === "snapshot" || d.u === 1;
      if (snapshot) this.book.clear();
      if (!snapshot && !this.ready) return true;
      this.applyRows("bid", d.b, recv, !snapshot);
      this.applyRows("ask", d.a, recv, !snapshot);
      if (snapshot) this.ready = true;
      return true;
    }
  }

  /** OKX books (400 levels): snapshot then updates; sizes in contracts; seq gap -> onGap() to resubscribe. */
  class OkxBook extends BookAdapter {
    constructor(opts) { super({ ...opts, scale: opts.ctVal }); this.instId = opts.instId; this.onGap = opts.onGap || (() => {}); this.seq = null; }
    handle(msg, recv) {
      if (!msg.arg || msg.arg.channel !== "books" || msg.arg.instId !== this.instId || !Array.isArray(msg.data)) return false;
      for (const d of msg.data) {
        if (msg.action === "snapshot") {
          this.book.clear();
          this.applyRows("bid", d.bids, recv, false);
          this.applyRows("ask", d.asks, recv, false);
          this.ready = true;
        } else if (this.ready) {
          if (d.prevSeqId !== this.seq) { this.reset(); this.onGap(); return true; }
          this.applyRows("bid", d.bids, recv, true);
          this.applyRows("ask", d.asks, recv, true);
        }
        this.seq = d.seqId;
      }
      return true;
    }
  }

  /**
   * Binance USD-M diff depth: buffer events, load a REST snapshot, then apply in sequence
   * (first event must straddle lastUpdateId; afterwards pu must equal the previous u, else resync).
   */
  class BinanceDepthBook extends BookAdapter {
    constructor(opts) { super(opts); this.buffer = []; this.lastU = null; this.needsSnapshot = true; this.maxBuffer = 2000; this.resyncing = false; }
    reset() { super.reset(); this.buffer = []; this.lastU = null; this.needsSnapshot = true; this.resyncing = false; }
    /** Ask for a fresh REST snapshot while staying live (events keep applying and are also buffered). */
    beginResync() { if (this.ready) { this.resyncing = true; this.buffer = []; this.needsSnapshot = true; } }
    handle(msg, recv) {
      if (!msg || msg.e !== "depthUpdate") return false;
      if (this.ready && this.resyncing) { this.buffer.push([msg, recv]); if (this.buffer.length > this.maxBuffer) this.buffer.shift(); }
      if (!this.ready) {
        this.buffer.push([msg, recv]);
        if (this.buffer.length > this.maxBuffer) this.buffer.shift();
        return true;
      }
      if (msg.pu !== this.lastU) { this.reset(); this.buffer.push([msg, recv]); return true; }
      this.applyEvent(msg, recv);
      return true;
    }
    applyEvent(ev, recv) {
      this.applyRows("bid", ev.b, recv, true);
      this.applyRows("ask", ev.a, recv, true);
      this.lastU = ev.u;
    }
    /** Live refresh: snapshot replaces our levels, newer buffered events replayed, nothing reported. */
    refresh(snap) {
      const L = snap.lastUpdateId, pending = this.buffer.filter(([ev]) => ev.u > L);
      this.book.clear();
      this.applyRows("bid", snap.bids, 0, false);
      this.applyRows("ask", snap.asks, 0, false);
      this.setReach(snap);
      for (const [ev] of pending) { this.applyRows("bid", ev.b, 0, false); this.applyRows("ask", ev.a, 0, false); }
      this.buffer = []; this.resyncing = false; this.needsSnapshot = false;
      return true;
    }

    setReach(snap) {
      const bids = snap.bids.map((r) => +r[0]), asks = snap.asks.map((r) => +r[0]);
      this.book.reach = { bid: bids.length ? Math.min(...bids) : null, ask: asks.length ? Math.max(...asks) : null };
    }

    /** Apply a REST /fapi/v1/depth answer and replay buffered events. */
    applySnapshot(snap, recv) {
      if (this.ready && this.resyncing) return this.refresh(snap);
      this.book.clear();
      this.applyRows("bid", snap.bids, recv, false);
      this.applyRows("ask", snap.asks, recv, false);
      this.setReach(snap);
      const L = snap.lastUpdateId;
      const pending = this.buffer.filter(([ev]) => ev.u >= L);
      this.buffer = [];
      this.needsSnapshot = false;
      if (pending.length && pending[0][0].U > L) { this.reset(); return false; }
      this.ready = true;
      this.lastU = null;
      for (const [ev, r] of pending) {
        if (this.lastU !== null && ev.pu !== this.lastU) { this.reset(); return false; }
        this.applyEvent(ev, r);
      }
      if (this.lastU === null) this.lastU = L;
      return true;
    }
  }

  /** OKX books-full (REST, up to 5000 levels): each answer replaces the deep book. Contracts x ctVal BTC. */
  class OkxDeepBook extends BookAdapter {
    constructor(opts) { super({ ...opts, scale: opts.ctVal }); this.deep = true; }
    applyRest(j) {
      const d = j.data[0];
      this.book.clear();
      this.applyRows("bid", d.bids, 0, false);
      this.applyRows("ask", d.asks, 0, false);
      this.ready = true;
    }
  }

  /** Binance partial depth (depth20@500ms, phone mode): each message is the top 20 levels; changes found by diffing. */
  class BinancePartialBook extends BookAdapter {
    constructor(opts) { super(opts); this.needsSnapshot = false; }
    handle(msg, recv) {
      if (!msg || msg.e !== "depthUpdate") return false;
      const report = this.ready;
      replaceSide(this, "bid", msg.b.map((r) => [+r[0], +r[1]]), recv, report);
      replaceSide(this, "ask", msg.a.map((r) => [+r[0], +r[1]]), recv, report);
      this.ready = true;
      return true;
    }
  }

  /** Replace one side of an adapter's book with [px, size] pairs, reporting each change. */
  function replaceSide(adapter, side, pairs, recv, report) {
    const next = new Map(pairs), book = adapter.book;
    for (const [px, old] of book.side(side)) if (!next.has(px)) { book.set(side, px, 0); if (report) adapter.onLevel(adapter.venue, side, px, old, 0, recv); }
    for (const [px, size] of next) {
      const old = book.set(side, px, size);
      if (report && old !== size) adapter.onLevel(adapter.venue, side, px, old, size, recv);
    }
  }

  /** Hyperliquid l2Book: every message is a full (20-level) snapshot; changes found by diffing. */
  class HlBook extends BookAdapter {
    handle(msg, recv) {
      if (msg.channel !== "l2Book" || !msg.data || !Array.isArray(msg.data.levels)) return false;
      const report = this.ready;
      const [bids, asks] = msg.data.levels;
      replaceSide(this, "bid", bids.map((l) => [+l.px, +l.sz]), recv, report);
      replaceSide(this, "ask", asks.map((l) => [+l.px, +l.sz]), recv, report);
      this.ready = true;
      return true;
    }
  }

  /**
   * Merged perp books: ladder, makers added/pulled, per-venue buckets for walls, levels for fuel cover.
   * Makers rule: a level change counts if within makersBandPct of price AND inside 90% of that book's
   * known reach (so levels sliding out of a top-N book are not counted as pulls). Size decreases are
   * "pulled" net of taker volume that hit that side of that venue's book in the same second.
   */
  class BookHub {
    constructor({ step = 10, halfRows = 60, makersBandPct = 0.01, bookInst = BOOK_INST } = {}) {
      this.step = step; this.halfRows = halfRows; this.band = makersBandPct; this.bookInst = bookInst;
      this.books = new Map(); this.deep = new Map(); this.px = 0; this.makers = new Map(); this.covCache = new Map();
    }

    /** Get or create the L2Book for a venue. */
    book(venue) {
      let b = this.books.get(venue);
      if (!b) { b = new L2Book(venue); this.books.set(venue, b); }
      return b;
    }

    /** Register an adapter's book under its venue (deep adapters go to the deep layer). */
    attach(adapter) { (adapter.deep ? this.deep : this.books).set(adapter.venue, adapter.book); }

    /** Get or create a venue's deep book: wide but slow (REST or coarse buckets), used beyond the live book's reach. */
    deepBook(venue) {
      let b = this.deep.get(venue);
      if (!b) { b = new L2Book(venue); this.deep.set(venue, b); }
      return b;
    }

    /** Every [side, px, size] to show: live books, plus deep levels beyond the live book's reach. */
    *allLevels(px) {
      for (const b of this.books.values()) for (const side of ["bid", "ask"]) for (const [p, s] of b.side(side)) yield [side, p, s];
      for (const [venue, d] of this.deep) {
        const live = this.books.get(venue);
        for (const side of ["bid", "ask"]) {
          const lim = live ? live.coverage(side, px) : 0;
          for (const [p, s] of d.side(side)) if (Math.abs(p - px) > lim) yield [side, p, s];
        }
      }
    }

    setPrice(px) { this.px = px; }

    makersAcc(sec) {
      let m = this.makers.get(sec);
      if (!m) { m = { bidAdded: 0, bidPulled: 0, askAdded: 0, askPulled: 0, bidFill: 0, askFill: 0 }; this.makers.set(sec, m); }
      return m;
    }

    coverage(venue, side, sec) {
      const key = `${venue}|${side}`, c = this.covCache.get(key);
      if (c && c.sec === sec) return c.value;
      const value = this.book(venue).coverage(side, this.px);
      this.covCache.set(key, { sec, value });
      return value;
    }

    /** Book adapters call this for every level change (sizes in BTC). */
    onLevel(venue, side, px, oldSize, newSize, recv) {
      if (!this.px) return;
      const dist = Math.abs(px - this.px), sec = Math.floor(recv / 1000);
      if (dist > this.band * this.px || dist > 0.9 * this.coverage(venue, side, sec)) return;
      const usd = Math.abs(newSize - oldSize) * px, m = this.makersAcc(sec);
      if (newSize > oldSize) m[`${side}Added`] += usd; else m[`${side}Pulled`] += usd;
    }

    /** Taker fills on a book venue's instrument (buys fill asks, sells fill bids). */
    onTrade(trade) {
      if (this.bookInst[trade.venue] !== trade.inst || !this.books.has(trade.venue)) return;
      const m = this.makersAcc(Math.floor(trade.recv / 1000));
      if (trade.side === "buy") m.askFill += trade.usd; else m.bidFill += trade.usd;
    }

    /** Makers for one closed second (removes it and anything older). */
    makersFor(sec) {
      const m = this.makers.get(sec);
      for (const s of this.makers.keys()) if (s <= sec) this.makers.delete(s);
      if (!m) return { bidAdded: 0, bidPulled: 0, askAdded: 0, askPulled: 0 };
      return { bidAdded: m.bidAdded, bidPulled: Math.max(0, m.bidPulled - m.bidFill), askAdded: m.askAdded, askPulled: Math.max(0, m.askPulled - m.askFill) };
    }

    /** Ladder of ~121 rows ($step buckets, px = bucket floor) centred on px, summed over all books. */
    ladder(px, at) {
      const k0 = Math.floor(px / this.step) - this.halfRows, n = 2 * this.halfRows + 1;
      const rows = Array.from({ length: n }, (_, j) => ({ px: (k0 + j) * this.step, bid: 0, ask: 0 }));
      for (const [side, p, size] of this.allLevels(px)) {
        const j = Math.floor(p / this.step + 1e-9) - k0;
        if (j >= 0 && j < n) rows[j][side] += p * size;
      }
      return { at, step: this.step, rows };
    }

    /** One venue's USD per $step bucket within bandPct of px and inside its reach (for walls). */
    venueBuckets(venue, px, bandPct) {
      const b = this.book(venue), out = new Map();
      for (const side of ["bid", "ask"]) {
        const lim = Math.min(bandPct * px, 0.9 * b.coverage(side, px));
        for (const [p, size] of b.side(side)) {
          if (Math.abs(p - px) > lim) continue;
          const k = Math.floor(p / this.step + 1e-9) * this.step;
          const cell = out.get(k) || { bid: 0, ask: 0 };
          cell[side] += p * size;
          out.set(k, cell);
        }
      }
      return out;
    }

    /** All held levels as {px, usd, isBid} (fuel cover), deep levels beyond live reach included. */
    levels(px = this.px) {
      const out = [];
      for (const [side, p, s] of this.allLevels(px)) out.push({ px: p, usd: p * s, isBid: side === "bid" });
      return out;
    }

    /** Drop far levels on every book (memory bound). */
    prune(px, pct = 0.1) { for (const b of [...this.books.values(), ...this.deep.values()]) b.prune(px * (1 - pct), px * (1 + pct)); }
  }

  // ───────────────────────────── 5. wall events ─────────────────────────────

  /**
   * Walls (our rules, per venue book, $step buckets):
   *  - A wall is a bucket within bandPct of price (and inside the book's reach) holding
   *    >= max(minUsd, ratio x median non-empty bucket) that has stood >= minAgeMs (10 s) before a pull counts.
   *    minUsd $20M matches the reference's smallest events (20.7M over 18 min, 2026-11-14).
   *  - When it drops to <= (1 - dropShare) of its peak: "eaten" if taker volume that reached it since
   *    it appeared >= eatShare x the drop, else "pulled". Size reported = peak.
   *  - "held" (once): takers put >= heldShare x peak into it and it still has >= heldKeep x peak.
   *  - Walls that vanish before minAgeMs, or leave the band, are dropped silently.
   *  - Pulls are held for flickerMs (10 s). If the same venue/side/bucket comes back as a wall in that time,
   *    it is tracked again and the whole on/off sequence ends as ONE "flicker" event (stamped at the first
   *    pull, size = largest peak) once it stays gone for flickerMs. Otherwise a "pulled" event, stamped at
   *    the pull, is emitted flickerMs later.
   */
  class WallDetector {
    constructor({ minUsd = 20e6, ratio = 4, bandPct = 0.006, minAgeMs = 10_000, step = 10, dropShare = 0.6, eatShare = 0.5, heldShare = 0.3, heldKeep = 0.6, flickerMs = 10_000 } = {}) {
      Object.assign(this, { minUsd, ratio, bandPct, minAgeMs, step, dropShare, eatShare, heldShare, heldKeep, flickerMs });
      this.tracked = new Map();
      this.pending = new Map();
      this.seq = 0;
    }

    /**
     * Update one venue from its current buckets.
     * @param {string} venue
     * @param {Map<number, {bid:number, ask:number}>} buckets
     * @param {number} px current price
     * @param {number} now ms
     * @returns {object[]} WallEvent[]
     */
    update(venue, buckets, px, now) {
      const thr = this.threshold(buckets);
      for (const [bpx, cell] of buckets) {
        if (Math.abs(bpx - px) > this.bandPct * px) continue;
        for (const side of ["bid", "ask"]) {
          const key = `${venue}|${side}|${bpx}`;
          if (cell[side] < thr || this.tracked.has(key)) continue;
          const back = this.pending.get(key);
          if (back) back.flicker = true;
          // a wall coming back during a pending pull counts as confirmed at once
          this.tracked.set(key, { venue, side, px: bpx, first: back ? now - this.minAgeMs : now, peak: cell[side], into: 0, held: false });
        }
      }
      const events = [];
      for (const [key, w] of this.tracked) {
        if (w.venue !== venue) continue;
        const cur = (buckets.get(w.px) || { bid: 0, ask: 0 })[w.side];
        const ev = this.judge(w, cur, px, now);
        if (ev === "drop") this.tracked.delete(key);
        else if (ev === "pulled") { this.holdPull(key, w, now); this.tracked.delete(key); }
        else if (ev) {
          events.push(this.event(now, ev, w.side, w.px, w.peak, venue));
          if (ev !== "held") this.tracked.delete(key);
        }
      }
      for (const [key, p] of this.pending) {
        if (p.venue !== venue || now < p.until || this.tracked.has(key)) continue;
        this.pending.delete(key);
        events.push(this.event(p.t, p.flicker ? "flicker" : "pulled", p.side, p.px, p.usd, venue));
      }
      return events;
    }

    holdPull(key, w, now) {
      const p = this.pending.get(key);
      if (p) { p.until = now + this.flickerMs; p.usd = Math.max(p.usd, w.peak); return; }
      this.pending.set(key, { venue: w.venue, side: w.side, px: w.px, t: now, usd: w.peak, until: now + this.flickerMs, flicker: false });
    }

    event(t, kind, side, px, usd, venue) { return { id: `w${++this.seq}-${t}`, t, kind, side, px, usd, venue }; }

    threshold(buckets) {
      const vals = [];
      for (const c of buckets.values()) { if (c.bid > 0) vals.push(c.bid); if (c.ask > 0) vals.push(c.ask); }
      return Math.max(this.minUsd, this.ratio * median(vals));
    }

    /** Decide what happened to one tracked wall: an event kind, "drop" (forget silently) or null. */
    judge(w, cur, px, now) {
      const confirmed = now - w.first >= this.minAgeMs;
      if (!confirmed) w.peak = Math.max(w.peak, cur);
      const gone = cur <= (1 - this.dropShare) * w.peak;
      if (Math.abs(w.px - px) > this.bandPct * px && !gone) return "drop";
      if (!confirmed) return gone ? "drop" : null;
      if (gone) return w.into >= this.eatShare * (w.peak - cur) ? "eaten" : "pulled";
      w.peak = Math.max(w.peak, cur);
      if (!w.held && w.into >= this.heldShare * w.peak && cur >= this.heldKeep * w.peak) { w.held = true; return "held"; }
      return null;
    }

    /** Taker trades that reach a tracked wall add to its "into" volume. */
    onTrade(trade) {
      for (const w of this.tracked.values()) {
        if (w.venue !== trade.venue || trade.recv < w.first) continue;
        if (BOOK_INST[w.venue] && BOOK_INST[w.venue] !== trade.inst) continue;
        const hits = w.side === "ask" ? trade.side === "buy" && trade.px >= w.px : trade.side === "sell" && trade.px < w.px + this.step;
        if (hits) w.into += trade.usd;
      }
    }

    /** Forget walls tracked for a venue (its book was reset). */
    forget(venue) {
      for (const [k, w] of this.tracked) if (w.venue === venue) this.tracked.delete(k);
      for (const [k, p] of this.pending) if (p.venue === venue) this.pending.delete(k);
    }
  }

  // ───────────────────────────── 6. pushes ─────────────────────────────

  /**
   * Pushes (our rules), evaluated once per closed second on perp taker flow over the last windowSec:
   *  - z = net / (1.4826 x median |net| of past windows over statsSec), share = dominant side / total.
   *  - Hard floor: no push of any kind unless |z| >= 2.
   *  - "sweep": a sweep (see SweepDetector) closed this second on the side the flow leans to.
   *    venue, usd and px are the sweep's. Same side again after sweepCooldownSec.
   *  - "burst": window volume >= burstMult x median past window volume, share >= shareBurst, |z| >= zMin.
   *  - "imbalance": |z| >= zImbalance and share >= shareImbalance.
   *  Checked in that order. No push in the first warmupSec. Burst/imbalance same side again after cooldownSec.
   *  For those, venue = the venue with the largest net flow in the push direction; usd = |net| over the window.
   */
  class PushDetector {
    constructor({ windowSec = 10, statsSec = 900, warmupSec = 180, zMin = 2, zImbalance = 3, shareImbalance = 0.65, burstMult = 4, shareBurst = 0.6, cooldownSec = 30, sweepCooldownSec = 10 } = {}) {
      Object.assign(this, { windowSec, statsSec, warmupSec, zMin, zImbalance, shareImbalance, burstMult, shareBurst, cooldownSec, sweepCooldownSec });
      this.win = []; this.hist = []; this.seen = 0; this.lastPush = { buy: -Infinity, sell: -Infinity }; this.lastSweep = { buy: -Infinity, sell: -Infinity }; this.seq = 0;
    }

    /**
     * @param {object} row a closed Second
     * @param {{side:string, usd:number}[]} sweeps sweeps closed in that second
     * @returns {object|null} Push
     */
    update(row, sweeps) {
      this.win.push({ row, sweeps });
      if (this.win.length > this.windowSec) this.win.shift();
      this.seen++;
      const w = this.windowStats();
      let push = null;
      if (this.seen >= this.warmupSec && this.hist.length >= 30) push = this.evaluate(w, row, sweeps || []);
      this.hist.push({ tot: w.buy + w.sell, net: w.buy - w.sell });
      if (this.hist.length > this.statsSec) this.hist.shift();
      return push;
    }

    windowStats() {
      let buy = 0, sell = 0;
      const venues = {};
      for (const { row } of this.win) {
        buy += row.perpBuy; sell += row.perpSell;
        for (const [v, [b, s]] of Object.entries(row.byVenue || {})) venues[v] = (venues[v] || 0) + b - s;
      }
      return { buy, sell, venues };
    }

    evaluate(w, row, sweeps) {
      const tot = w.buy + w.sell, net = w.buy - w.sell;
      if (tot <= 0) return null;
      const sd = 1.4826 * median(this.hist.map((h) => Math.abs(h.net)));
      const z = net / Math.max(sd, 1), share = Math.max(w.buy, w.sell) / tot, side = net >= 0 ? "buy" : "sell";
      const az = Math.abs(z), zr = Math.round(z * 10) / 10;
      if (az < Z_FLOOR) return null;
      const sw = sweeps.filter((s) => s.side === side).sort((a, b) => b.usd - a.usd)[0];
      if (sw && row.t - this.lastSweep[side] >= this.sweepCooldownSec * 1000) {
        this.lastSweep[side] = row.t;
        return { id: `p${++this.seq}-${row.t}`, t: row.t, side, kind: "sweep", z: zr, usd: sw.usd, venue: sw.venue, px: sw.px };
      }
      let kind = null;
      if (tot >= this.burstMult * median(this.hist.map((h) => h.tot)) && share >= this.shareBurst && az >= this.zMin) kind = "burst";
      else if (az >= this.zImbalance && share >= this.shareImbalance) kind = "imbalance";
      if (!kind || row.t - this.lastPush[side] < this.cooldownSec * 1000) return null;
      this.lastPush[side] = row.t;
      return { id: `p${++this.seq}-${row.t}`, t: row.t, side, kind, z: zr, usd: Math.abs(net), venue: leader(w.venues, side), px: row.px };
    }
  }

  function leader(venues, side) {
    let best = null, bestVal = -Infinity;
    for (const [v, net] of Object.entries(venues)) {
      const val = side === "buy" ? net : -net;
      if (val > bestVal) { best = v; bestVal = val; }
    }
    return best;
  }

  /** Median of a numeric array (0 for empty). */
  function median(values) {
    if (!values.length) return 0;
    const s = Float64Array.from(values).sort(), mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // ───────────────────────────── 7. fuel ─────────────────────────────
  // Port of liqfun_work/fuel_model/fuel.py (OI-delta leverage model fitted to the reference feed).

  /** Fitted parameters (liqfun_work/fuel_model/config_fit.json) plus model defaults. */
  const FUEL_CONFIG = Object.freeze({
    distances: [0.01, 0.0125, 0.015, 0.02, 0.03, 0.035, 0.08, 0.1],
    weights: [1.0, 0.0625, 0.0078125, 0.015625, 0.5, 0.0625, 0.25, 1.0],
    tauHours: 12, lookbackHours: 240, grid: 12.5, windowHalf: 25, minSeparation: 125, rangePct: 0.06,
    maxPerSide: 14, oiScale: 15.575375976732692, bookBandPct: 0.01, bookScale: 1, armedPerSide: 4, armedRangePct: 0.03,
  });

  /** Long and short liquidation USD on a fixed price grid. */
  class HeatCurve {
    constructor(grid0, step, n) { this.grid0 = grid0; this.step = step; this.long = new Float64Array(n); this.short = new Float64Array(n); }
    price(i) { return this.grid0 + this.step * i; }
    index(px) { return Math.round((px - this.grid0) / this.step); }
    /** Add USD at a price ("long" or "short"); off-grid prices are ignored. */
    add(px, usd, side) {
      const i = this.index(px), arr = side === "long" ? this.long : this.short;
      if (i >= 0 && i < arr.length) arr[i] += usd;
    }
    /** Sum of each cell and its neighbours within +-half USD. */
    windowSum(side, half) {
      const arr = side === "long" ? this.long : this.short, k = Math.round(half / this.step), n = arr.length;
      const cum = new Float64Array(n + 1);
      for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + arr[i];
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) out[i] = cum[Math.min(n, i + k + 1)] - cum[Math.max(0, i - k)];
      return out;
    }
  }

  /** Empty grid spanning +-2x the cluster range around px. */
  function emptyCurve(px, cfg = FUEL_CONFIG) {
    const span = px * cfg.rangePct * 2, grid0 = Math.floor((px - span) / cfg.grid) * cfg.grid;
    return new HeatCurve(grid0, cfg.grid, Math.floor((2 * span) / cfg.grid) + 2);
  }

  /**
   * Build the OI-delta heat curve from closed 5m bars.
   * @param {{openMs:number, high:number, low:number, close:number, oi:number, buyShare:number}[]} bars
   */
  function buildHeat(bars, nowMs, px, cfg = FUEL_CONFIG) {
    if (cfg.distances.length !== cfg.weights.length) throw new Error("distances and weights must have the same length");
    const start = nowMs - cfg.lookbackHours * HOUR;
    const use = bars.filter((b) => b.openMs >= start && b.openMs + 300_000 <= nowMs);
    if (use.length < 2) throw new Error(`need at least 2 closed bars, got ${use.length}`);
    const curve = emptyCurve(px, cfg), n = use.length;
    const typical = use.map((b) => (b.high + b.low + b.close) / 3);
    const added = use.map((b, i) => {
      const d = i === 0 ? 0 : Math.max(0, b.oi - use[i - 1].oi);
      const decay = cfg.tauHours ? Math.exp(-(nowMs - (b.openMs + 300_000)) / HOUR / cfg.tauHours) : 1;
      return d * typical[i] * cfg.oiScale * decay;
    });
    const lowAfter = new Float64Array(n), highAfter = new Float64Array(n);
    lowAfter[n - 1] = Infinity; highAfter[n - 1] = -Infinity;
    for (let i = n - 2; i >= 0; i--) { lowAfter[i] = Math.min(lowAfter[i + 1], use[i + 1].low); highAfter[i] = Math.max(highAfter[i + 1], use[i + 1].high); }
    const wsum = cfg.weights.reduce((a, b) => a + b, 0);
    cfg.distances.forEach((dist, j) => {
      const share = cfg.weights[j] / wsum;
      for (let i = 0; i < n; i++) {
        if (!added[i]) continue;
        const longPx = typical[i] * (1 - dist), shortPx = typical[i] * (1 + dist);
        if (lowAfter[i] > longPx) curve.add(longPx, added[i] * use[i].buyShare * share, "long");
        if (highAfter[i] < shortPx) curve.add(shortPx, added[i] * (1 - use[i].buyShare) * share, "short");
      }
    });
    return curve;
  }

  /** Greedy peaks of the window-summed curve, minSeparation apart, within rangePct of px. */
  function pickClusters(curve, px, cfg = FUEL_CONFIG) {
    const out = [];
    for (const side of ["long", "short"]) {
      const vals = curve.windowSum(side, cfg.windowHalf), idx = [];
      for (let i = 0; i < vals.length; i++) {
        const p = curve.price(i);
        const inRange = side === "long" ? p < px && p > px * (1 - cfg.rangePct) : p > px && p < px * (1 + cfg.rangePct);
        if (inRange && vals[i] > 0) idx.push(i);
      }
      idx.sort((a, b) => vals[b] - vals[a] || a - b);
      const chosen = [];
      for (const i of idx) {
        if (chosen.every((j) => Math.abs(curve.price(i) - curve.price(j)) >= cfg.minSeparation)) chosen.push(i);
        if (chosen.length >= cfg.maxPerSide) break;
      }
      for (const i of chosen) out.push({ px: curve.price(i), usd: vals[i], side: side === "long" ? "longs" : "shorts" });
    }
    return out;
  }

  /**
   * Contract Fuel.levels: clusters with armed flag (top armedPerSide per side within armedRangePct) and
   * cover = opposite-side book USD within bookBandPct of the level / cluster USD.
   */
  function clusters(bars, nowMs, px, cfg = FUEL_CONFIG, book = null) {
    const peaks = pickClusters(buildHeat(bars, nowMs, px, cfg), px, cfg);
    const armed = new Set();
    for (const side of ["longs", "shorts"]) {
      peaks.filter((p) => p.side === side && Math.abs(p.px / px - 1) <= cfg.armedRangePct)
        .sort((a, b) => b.usd - a.usd).slice(0, cfg.armedPerSide).forEach((p) => armed.add(p));
    }
    return peaks.map((p) => {
      const lo = p.px * (1 - cfg.bookBandPct), hi = p.px * (1 + cfg.bookBandPct), wantBid = p.side === "longs";
      let bookUsd = 0;
      if (book) for (const l of book) if (l.isBid === wantBid && l.px >= lo && l.px <= hi) bookUsd += l.usd;
      bookUsd *= cfg.bookScale;
      const cover = book && p.usd > 0 ? Math.round((bookUsd / p.usd) * 100) / 100 : 0;
      return { px: p.px, usd: p.usd, side: p.side, armed: armed.has(p), cover, bookUsd };
    }).sort((a, b) => a.px - b.px);
  }

  /**
   * Join 5m klines (keyed by open) with OI series (keyed by bar close, BTC) and Binance buy/sell ratio.
   * OI is forward filled per series; bars before every series has a value are dropped.
   * @param {Array[]} klines Binance kline rows
   * @param {Map<number, number>[]} oiSeries
   * @param {Map<number, number>} ratio buySellRatio keyed by bar open
   */
  function joinBars(klines, oiSeries, ratio) {
    const last = oiSeries.map(() => undefined), bars = [];
    for (const k of [...klines].sort((a, b) => a[0] - b[0])) {
      const openMs = +k[0], closeMs = openMs + 300_000;
      oiSeries.forEach((s, i) => { if (s.has(closeMs)) last[i] = s.get(closeMs); });
      if (last.some((v) => v === undefined)) continue;
      const r = ratio.get(openMs);
      bars.push({ openMs, high: +k[2], low: +k[3], close: +k[4], oi: last.reduce((a, b) => a + b, 0), buyShare: r > 0 ? r / (1 + r) : 0.5 });
    }
    if (bars.length < 2) throw new Error(`only ${bars.length} bars after join; OI series missing?`);
    return bars;
  }

  /** GET/POST JSON; throws on network error or non-2xx. */
  async function getJson(fetchFn, url, init) {
    const resp = await fetchFn(url, init);
    if (!resp.ok) throw new Error(`HTTP ${resp.status} from ${new URL(url).host}`);
    return resp.json();
  }

  /** URL through the Mac dash proxy (for endpoints without CORS). */
  function proxied(proxyBase, url) { return `${proxyBase.replace(/\/$/, "")}/proxy?u=${encodeURIComponent(url)}`; }

  /** Public inputs for the fuel model: Binance klines/OI/taker ratio, Bybit OI, OKX OI (proxy only). */
  class FuelFeed {
    constructor({ fetch, proxyBase = null }) { this.fetch = fetch; this.proxyBase = proxyBase; }

    /** @returns {Promise<{bars: object[], withOkx: boolean}>} */
    async bars(startMs, endMs) {
      const klines = await this.klines(startMs, endMs);
      const bn = await this.binanceSeries("openInterestHist", "sumOpenInterest", startMs, endMs);
      const taker = await this.binanceSeries("takerlongshortRatio", "buySellRatio", startMs, endMs);
      const by = await this.bybitOi(startMs, endMs);
      let okx = null;
      if (this.proxyBase) okx = await this.okxOi(startMs, endMs);
      const firstClose = klines.length ? +klines[0][0] + 300_000 : 0;
      const withOkx = !!okx && okx.size > 0 && Math.min(...okx.keys()) <= firstClose;
      const series = withOkx ? [bn, by, okx] : [bn, by];
      return { bars: joinBars(klines, series, taker), withOkx };
    }

    async klines(startMs, endMs) {
      const out = [];
      for (let t = startMs; t < endMs;) {
        const page = await getJson(this.fetch, `https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=5m&startTime=${t}&limit=1500`);
        if (!page.length) break;
        out.push(...page);
        t = +page[page.length - 1][0] + 300_000;
      }
      return out;
    }

    async binanceSeries(path, key, startMs, endMs) {
      const out = new Map();
      for (let t = startMs; t < endMs;) {
        const stop = Math.min(endMs, t + 499 * 300_000);
        const rows = await getJson(this.fetch, `https://fapi.binance.com/futures/data/${path}?symbol=BTCUSDT&period=5m&limit=500&startTime=${t}&endTime=${stop}`);
        for (const r of rows) out.set(+r.timestamp, +r[key]);
        t = stop + 300_000;
      }
      return out;
    }

    async bybitOi(startMs, endMs) {
      const out = new Map();
      for (let stop = endMs; stop > startMs;) {
        const j = await getJson(this.fetch, `https://api.bybit.com/v5/market/open-interest?category=linear&symbol=BTCUSDT&intervalTime=5min&limit=200&endTime=${stop}`);
        const rows = j.result.list;
        if (!rows.length) break;
        for (const r of rows) out.set(+r.timestamp, +r.openInterest);
        stop = Math.min(...rows.map((r) => +r.timestamp)) - 1;
      }
      return out;
    }

    async okxOi(startMs, endMs) {
      const out = new Map();
      for (let end = endMs; end > startMs;) {
        const url = `https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=BTC-USDT-SWAP&period=5m&limit=100&end=${end}`;
        const j = await getJson(this.fetch, proxied(this.proxyBase, url));
        if (!j.data || !j.data.length) break;
        for (const r of j.data) out.set(+r[0], +r[2]);
        end = Math.min(...j.data.map((r) => +r[0])) - 1;
      }
      return out;
    }
  }

  // ───────────────────────────── 8. open interest, usual volume, HL stops ─────────────────────────────

  /**
   * Current OI and funding for every BTC perp the flow covers, from public REST, in coin terms per venue:
   * Binance USDT + USDC + coin-M, Bybit USDT + USDC + inverse, OKX USDT + USD swaps, Hyperliquid, Bitget
   * USDT + USDC, Gate, Deribit inverse + USDC, Aster; KuCoin only through the proxy (no CORS).
   * MEXC is off by default: its holdVol (64k BTC on 2026-11-14) looks two-sided, and the reference total
   * matches within 1% without it. Funding is each venue's main contract, as an 8h fraction.
   */
  class OiFeed {
    constructor({ fetch, proxyBase = null, venues = null, includeMexc = false }) {
      this.fetch = fetch; this.proxyBase = proxyBase;
      this.venues = venues || ["Binance", "Bybit", "OKX", "Hyperliquid", "Bitget", "Gate", "Deribit", "Aster", ...(proxyBase ? ["KuCoin"] : []), ...(proxyBase && includeMexc ? ["MEXC"] : [])];
      this.errors = {}; this.lastError = {};
    }

    get(url, init) { return getJson(this.fetch, url, init); }
    viaProxy(url) { return getJson(this.fetch, proxied(this.proxyBase, url)); }

    /** @returns {Promise<{venue:string, coin:number, usd:number, funding8h:number|null}[]>} venues that answered */
    async poll() {
      const res = await Promise.all(this.venues.map((v) => this[`fetch${v}`]().catch((e) => {
        this.errors[v] = (this.errors[v] || 0) + 1; this.lastError[v] = String(e && e.message); return null;
      })));
      return res.filter(Boolean).map((r) => (r.parts ? r : { ...r, parts: { [`${r.venue}|*`]: r.coin } }));
    }

    async fetchBinance() {
      const F = "https://fapi.binance.com/fapi/v1", D = "https://dapi.binance.com/dapi/v1";
      const [usdt, usdc, pi, cm, cmPi] = await Promise.all([
        this.get(`${F}/openInterest?symbol=BTCUSDT`), this.get(`${F}/openInterest?symbol=BTCUSDC`), this.get(`${F}/premiumIndex?symbol=BTCUSDT`),
        this.get(`${D}/openInterest?symbol=BTCUSD_PERP`), this.get(`${D}/premiumIndex?symbol=BTCUSD_PERP`),
      ]);
      const mark = +pi.markPrice, cmMark = +[].concat(cmPi)[0].markPrice;
      const cmUsd = +cm.openInterest * BINANCE_COINM_USD, coin = +usdt.openInterest + +usdc.openInterest + cmUsd / cmMark;
      return { venue: "Binance", coin, usd: (+usdt.openInterest + +usdc.openInterest) * mark + cmUsd, funding8h: +pi.lastFundingRate,
        parts: { "Binance|BTCUSDT": +usdt.openInterest, "Binance|BTCUSDC": +usdc.openInterest, "Binance|BTCUSD_PERP": cmUsd / cmMark } };
    }

    /** Bybit inverse: openInterest is USD, openInterestValue is BTC. */
    async fetchBybit() {
      const t = (q) => this.get(`https://api.bybit.com/v5/market/tickers?${q}`).then((j) => j.result.list[0]);
      const [usdt, perp, inv] = await Promise.all([t("category=linear&symbol=BTCUSDT"), t("category=linear&symbol=BTCPERP"), t("category=inverse&symbol=BTCUSD")]);
      return { venue: "Bybit", coin: +usdt.openInterest + +perp.openInterest + +inv.openInterestValue, usd: +usdt.openInterestValue + +perp.openInterestValue + +inv.openInterest, funding8h: +usdt.fundingRate,
        parts: { "Bybit|BTCUSDT": +usdt.openInterest, "Bybit|BTCPERP": +perp.openInterest, "Bybit|BTCUSD": +inv.openInterestValue } };
    }

    async fetchOKX() {
      const P = "https://www.okx.com/api/v5/public";
      const [a, b, fr] = await Promise.all([this.get(`${P}/open-interest?instType=SWAP&instId=BTC-USDT-SWAP`), this.get(`${P}/open-interest?instType=SWAP&instId=BTC-USD-SWAP`), this.get(`${P}/funding-rate?instId=BTC-USDT-SWAP`)]);
      return { venue: "OKX", coin: +a.data[0].oiCcy + +b.data[0].oiCcy, usd: +a.data[0].oiUsd + +b.data[0].oiUsd, funding8h: +fr.data[0].fundingRate,
        parts: { "OKX|BTC-USDT-SWAP": +a.data[0].oiCcy, "OKX|BTC-USD-SWAP": +b.data[0].oiCcy } };
    }

    /** Hyperliquid funding is hourly; scaled x8 to an 8h rate. */
    async fetchHyperliquid() {
      const [meta, ctxs] = await this.get("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "metaAndAssetCtxs" }) });
      const i = meta.universe.findIndex((u) => u.name === "BTC");
      if (i < 0) throw new Error("BTC not in Hyperliquid universe");
      const c = ctxs[i], coin = +c.openInterest;
      return { venue: "Hyperliquid", coin, usd: coin * +c.markPx, funding8h: +c.funding * 8 };
    }

    async fetchBitget() {
      const M = "https://api.bitget.com/api/v2/mix/market";
      const [a, b, tk] = await Promise.all([this.get(`${M}/open-interest?symbol=BTCUSDT&productType=usdt-futures`), this.get(`${M}/open-interest?symbol=BTCPERP&productType=usdc-futures`), this.get(`${M}/ticker?symbol=BTCUSDT&productType=usdt-futures`)]);
      const coin = +a.data.openInterestList[0].size + +b.data.openInterestList[0].size, t = tk.data[0];
      return { venue: "Bitget", coin, usd: coin * +t.markPrice, funding8h: +t.fundingRate };
    }

    async fetchGate() {
      const c = await this.get("https://api.gateio.ws/api/v4/futures/usdt/contracts/BTC_USDT");
      const coin = +c.position_size * +c.quanto_multiplier;
      return { venue: "Gate", coin, usd: coin * +c.mark_price, funding8h: +c.funding_rate };
    }

    /** Deribit inverse perp OI is USD; the USDC perp is BTC. */
    async fetchDeribit() {
      const q = (i) => this.get(`https://www.deribit.com/api/v2/public/get_book_summary_by_instrument?instrument_name=${i}`).then((j) => j.result[0]);
      const [inv, usdc] = await Promise.all([q("BTC-PERPETUAL"), q("BTC_USDC-PERPETUAL")]);
      return { venue: "Deribit", coin: +inv.open_interest / +inv.mark_price + +usdc.open_interest, usd: +inv.open_interest + +usdc.open_interest * +usdc.mark_price, funding8h: +inv.funding_8h };
    }

    async fetchAster() {
      const [oi, pi] = await Promise.all([this.get("https://fapi.asterdex.com/fapi/v1/openInterest?symbol=BTCUSDT"), this.get("https://fapi.asterdex.com/fapi/v1/premiumIndex?symbol=BTCUSDT")]);
      const coin = +oi.openInterest;
      return { venue: "Aster", coin, usd: coin * +pi.markPrice, funding8h: +pi.lastFundingRate };
    }

    async fetchKuCoin() {
      const d = (await this.viaProxy("https://api-futures.kucoin.com/api/v1/contracts/XBTUSDTM")).data;
      const coin = +d.openInterest * +d.multiplier;
      return { venue: "KuCoin", coin, usd: coin * +d.markPrice, funding8h: +d.fundingFeeRate };
    }

    async fetchMEXC() {
      const d = (await this.viaProxy("https://contract.mexc.com/api/v1/contract/ticker?symbol=BTC_USDT")).data;
      const coin = +d.holdVol * MEXC_BTC;
      return { venue: "MEXC", coin, usd: coin * +d.fairPrice, funding8h: +d.fundingRate };
    }

    /**
     * 5m OI history (BTC), last ~70 min, per instrument, only where the history means the same as our live
     * number: Binance BTCUSDT and BTCUSDC, Bybit BTCUSDT and BTCPERP, OKX BTC-USDT-SWAP (proxy only).
     * Not seeded (definition differs from live): Binance coin-M (14.7M vs 12.2M contracts), Gate (about 2x, two-sided),
     * Bybit inverse (USD only). Those series start from our own samples.
     */
    async seed() {
      const out = {}, F = "https://fapi.binance.com/futures/data/openInterestHist";
      for (const sym of ["BTCUSDT", "BTCUSDC"]) out[`Binance|${sym}`] = (await this.get(`${F}?symbol=${sym}&period=5m&limit=14`)).map((r) => ({ t: +r.timestamp, coin: +r.sumOpenInterest }));
      for (const sym of ["BTCUSDT", "BTCPERP"]) {
        const j = await this.get(`https://api.bybit.com/v5/market/open-interest?category=linear&symbol=${sym}&intervalTime=5min&limit=14`);
        out[`Bybit|${sym}`] = j.result.list.map((r) => ({ t: +r.timestamp, coin: +r.openInterest }));
      }
      if (this.proxyBase) {
        const j = await this.viaProxy("https://www.okx.com/api/v5/rubik/stat/contracts/open-interest-history?instId=BTC-USDT-SWAP&period=5m&limit=14");
        out["OKX|BTC-USDT-SWAP"] = j.data.map((r) => ({ t: +r[0], coin: +r[2] }));
      }
      return out;
    }
  }

  /**
   * OI totals and changes. d5Pct / d1hPct are in percent, in coin terms (price moves do not show up as OI
   * change). Changes compare like with like: each instrument series (e.g. "Binance|BTCUSDC") counts only if it
   * has a point near both times, and the matched series must hold >= minCover (40%) of today's OI, else null.
   * So a first poll where some venues failed, or a REST seed covering fewer instruments than the live number,
   * never makes a fake jump; the stats are null until we hold samples that old. Funding is OI-weighted.
   */
  class OiTracker {
    constructor({ keepMs = 70 * MIN, minCover = 0.4 } = {}) { this.keepMs = keepMs; this.minCover = minCover; this.series = new Map(); this.latest = new Map(); }

    static key(k) { return k.includes("|") ? k : `${k}|*`; }

    /** One series' points (a venue name alone means its single whole-venue series). */
    history(key) { return this.series.get(OiTracker.key(key)) || []; }

    /** Add older points (5m REST history) to one series. */
    seed(key, points) {
      const k = OiTracker.key(key);
      this.series.set(k, [...this.history(k), ...points].sort((a, b) => a.t - b.t));
    }

    /** Record a live sample; parts = {seriesKey: coin} (default: the whole venue as one series). */
    ingest(venue, t, coin, usd, funding8h, parts = { [`${venue}|*`]: coin }) {
      for (const [k, c] of Object.entries(parts)) {
        const h = this.history(k);
        h.push({ t, coin: c });
        while (h.length > 1 && h[0].t < t - this.keepMs) h.shift();
        this.series.set(k, h);
      }
      this.latest.set(venue, { t, coin, usd, funding8h, parts });
    }

    /** Contract OpenInterest, or null before the first sample. */
    snapshot(now) {
      if (!this.latest.size) return null;
      let usd = 0, fw = 0, fu = 0;
      for (const l of this.latest.values()) {
        usd += l.usd;
        if (l.funding8h != null && Number.isFinite(l.funding8h)) { fw += l.funding8h * l.usd; fu += l.usd; }
      }
      return { at: now, usd, d5Pct: this.change(now, 5 * MIN, 90_000), d1hPct: this.change(now, HOUR, 6 * MIN), funding8h: fu ? fw / fu : null };
    }

    change(now, lag, tol) {
      let a = 0, b = 0, total = 0;
      const target = now - lag;
      for (const l of this.latest.values()) {
        total += l.coin;
        for (const [k, c] of Object.entries(l.parts)) {
          let best = null;
          for (const p of this.history(k)) if (Math.abs(p.t - target) <= tol && (!best || Math.abs(p.t - target) < Math.abs(best.t - target))) best = p;
          if (best) { a += c; b += best.coin; }
        }
      }
      if (!(b > 0) || a < this.minCover * total) return null;
      return (a / b - 1) * 100;
    }
  }

  /**
   * Typical share of all-venue BTC perp taker volume per venue, from the reference feed over a 10-minute
   * sample (2026-11-14 20:01 UTC). Used only to fill in venues we do not see (Lighter, a venue down since start).
   */
  const DEFAULT_SHARES = Object.freeze({ Binance: 0.265, Hyperliquid: 0.16, OKX: 0.125, Deribit: 0.119, Gate: 0.098, Bybit: 0.085, MEXC: 0.057, Bitget: 0.04, Lighter: 0.029, Aster: 0.009, KuCoin: 0.008, Pacifica: 0.005, Extended: 0.002 });

  /** Venues/instruments in the usual-volume baseline (all have 7 days of public 1m klines with CORS). */
  function inBaseline(t) {
    return t.venue === "Binance" || (t.venue === "Bybit" && t.inst === "BTCUSDT") || (t.venue === "OKX" && t.inst === "BTC-USDT-SWAP");
  }

  const RATIO_KEY = "flowEngine.usualRatio";
  /** All-venue / baseline-instrument volume ratio measured 2026-11-14 (live runs gave 2.2 to 2.3); used until better data exists. */
  const USUAL_PRIOR_RATIO = 2.25;

  /** localStorage if the environment allows it, else null. */
  function defaultStorage() {
    try { return typeof window !== "undefined" && window.localStorage ? window.localStorage : null; } catch (e) { return null; }
  }

  /**
   * Usual 1-minute perp taker volume for the current UTC hour (proxy for the reference's 7-day median of
   * all-venue minute volume):
   *   baseline = median over the same UTC hour on the previous 7 days (420 minutes) of the per-minute sum of
   *              Binance BTCUSDT + BTCUSDC + coin-M, Bybit BTCUSDT and OKX BTC-USDT-SWAP quote volume
   *              (quote volume counts each trade once = taker buy + taker sell). About 45% of all flow.
   *   vol1m    = baseline x ratio, ratio = all-venue perp volume / those baseline instruments, from our own flow.
   * The ratio uses our last 60 min once we have 30 min; it is cached in localStorage (refreshed hourly,
   * trusted for 24 h) and the cached value is used until our own 30 min exist; with no cache, our own
   * ratio after 2 min, and USUAL_PRIOR_RATIO before that (so vol1m shows as soon as the klines answer). Venues we do not see (Lighter, a venue down since start) are filled in from
   * DEFAULT_SHARES. coverage = share of the usual volume from venues live now; vol1mLive = vol1m x coverage.
   */
  class UsualVolume {
    constructor({ minLiveSeconds = 120, cacheMinSeconds = 1800, keepSeconds = 3600, defaultShares = DEFAULT_SHARES, storage = defaultStorage() } = {}) {
      Object.assign(this, { minLive: minLiveSeconds, cacheMin: cacheMinSeconds, keep: keepSeconds, shares: defaultShares, storage });
      this.base = null; this.hour = null; this.asOf = null; this.secs = new Map();
    }

    /** Same UTC hour on each of the previous 7 days. */
    static hourStarts(now) {
      const h = Math.floor(now / HOUR) * HOUR;
      return [1, 2, 3, 4, 5, 6, 7].map((d) => h - d * 24 * HOUR);
    }

    setBaseline(hour, minuteVolumes, asOf) { this.hour = hour; this.base = median(minuteVolumes); this.asOf = asOf; }

    onTrade(trade) {
      if (trade.kind !== "perp") return;
      const sec = Math.floor(trade.recv / 1000);
      let s = this.secs.get(sec);
      if (!s) {
        s = { cov: 0, venues: {} }; this.secs.set(sec, s);
        for (const k of this.secs.keys()) { if (k > sec - this.keep) break; this.secs.delete(k); }
      }
      s.venues[trade.venue] = (s.venues[trade.venue] || 0) + trade.usd;
      if (inBaseline(trade)) s.cov += trade.usd;
    }

    /** Our own full ratio and per-venue estimates over the window, or null with too little data. */
    own(now) {
      const nowSec = Math.floor(now / 1000), vol = {};
      let cov = 0, first = Infinity, last = -Infinity;
      for (const [sec, s] of this.secs) {
        if (sec <= nowSec - this.keep) continue;
        cov += s.cov; first = Math.min(first, sec); last = Math.max(last, sec);
        for (const [v, u] of Object.entries(s.venues)) vol[v] = (vol[v] || 0) + u;
      }
      const span = last - first + 1;
      if (!(cov > 0) || span < this.minLive) return null;
      const r = {};
      for (const [v, u] of Object.entries(vol)) r[v] = u / cov;
      let listed = 0, listedShare = 0;
      for (const [v, x] of Object.entries(r)) if (v in this.shares) { listed += x; listedShare += this.shares[v]; }
      const perShare = listedShare > 0 ? listed / listedShare : 0, est = { ...r };
      for (const v of Object.keys(this.shares)) if (!(v in r)) est[v] = this.shares[v] * perShare;
      return { full: Object.values(est).reduce((a, b) => a + b, 0), est, span };
    }

    readCache(now) {
      try {
        const c = this.storage && JSON.parse(this.storage.getItem(RATIO_KEY) || "null");
        return c && c.ratio > 0 && now - c.at < 24 * HOUR ? c : null;
      } catch (e) { return null; }
    }

    writeCache(ratio, now) {
      const c = this.readCache(now);
      if (c && now - c.at < HOUR) return;
      try { if (this.storage) this.storage.setItem(RATIO_KEY, JSON.stringify({ ratio, at: now })); } catch (e) { /* storage blocked: keep running on live data */ }
    }

    /**
     * @param {number} now
     * @param {Set<string>} [live] perp venues live now (default: every venue observed)
     * @returns {{vol1m:number|null, vol1mLive:number|null, coverage:number|null, asOf:number|null, ratio:number|null}}
     */
    value(now, live) {
      const own = this.own(now), cache = this.readCache(now);
      let ratio = null;
      if (own && own.span >= this.cacheMin) { ratio = own.full; this.writeCache(ratio, now); } else if (cache) ratio = cache.ratio; else if (own) ratio = own.full; else ratio = USUAL_PRIOR_RATIO;
      let coverage = null;
      if (own) {
        const liveSet = live || new Set(Object.keys(own.est));
        coverage = Object.entries(own.est).filter(([v]) => liveSet.has(v)).reduce((a, [, x]) => a + x, 0) / own.full;
      } else if (live) {
        const all = Object.values(this.shares).reduce((a, b) => a + b, 0);
        coverage = Object.entries(this.shares).filter(([v]) => live.has(v)).reduce((a, [, x]) => a + x, 0) / all;
      }
      if (this.base == null || ratio == null) return { vol1m: null, vol1mLive: null, coverage, asOf: null, ratio };
      const vol1m = this.base * ratio;
      return { vol1m, vol1mLive: coverage == null ? null : vol1m * coverage, coverage, asOf: this.asOf, ratio };
    }
  }

  /** 1m klines for the usual-volume baseline: 7 days x (Binance USDT, USDC, coin-M, Bybit, OKX) = 35 calls/hour. */
  class UsualFeed {
    constructor({ fetch }) { this.fetch = fetch; }

    /** @returns {Promise<number[]>} per-minute USD sums over the 420 baseline minutes */
    async minuteVolumes(now) {
      const sums = new Map(), add = (t, usd) => sums.set(+t, (sums.get(+t) || 0) + usd);
      const jobs = [];
      for (const s of UsualVolume.hourStarts(now)) {
        const e = s + HOUR - 1, get = (u) => getJson(this.fetch, u);
        for (const sym of ["BTCUSDT", "BTCUSDC"]) jobs.push(get(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=1m&startTime=${s}&limit=60`).then((rows) => rows.forEach((k) => add(k[0], +k[7]))));
        jobs.push(get(`https://dapi.binance.com/dapi/v1/klines?symbol=BTCUSD_PERP&interval=1m&startTime=${s}&limit=60`).then((rows) => rows.forEach((k) => add(k[0], +k[5] * BINANCE_COINM_USD))));
        jobs.push(get(`https://api.bybit.com/v5/market/kline?category=linear&symbol=BTCUSDT&interval=1&start=${s}&end=${e}&limit=60`).then((j) => j.result.list.forEach((k) => add(k[0], +k[6]))));
        jobs.push(get(`https://www.okx.com/api/v5/market/history-candles?instId=BTC-USDT-SWAP&bar=1m&after=${e + 1}&before=${s - 1}&limit=100`).then((j) => j.data.forEach((k) => add(k[0], +k[7]))));
      }
      await Promise.all(jobs);
      return [...sums.values()];
    }
  }

  /**
   * Hyperliquid stops (approximate): wallets seen taking >= $100k on HL BTC are remembered by notional;
   * every refresh the top maxWallets are asked for frontendOpenOrders and their BTC stop triggers kept.
   * Position TP/SL orders with size 0 are skipped (sizing them needs clearinghouseState per wallet).
   */
  class StopsTracker {
    constructor({ fetch, maxWallets = 20, spacingMs = 300, maxKnown = 500, top = 30, sleep }) {
      Object.assign(this, { fetch, maxWallets, spacingMs, maxKnown, top });
      this.wallets = new Map(); this.stops = []; this.at = null; this.errors = 0;
      this.sleep = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    }

    noteWallet(addr, usd) {
      this.wallets.set(addr, (this.wallets.get(addr) || 0) + usd);
      if (this.wallets.size > this.maxKnown) {
        const smallest = [...this.wallets].sort((a, b) => a[1] - b[1])[0][0];
        this.wallets.delete(smallest);
      }
    }

    /** @returns {Promise<{px:number, usd:number, side:"buy"|"sell"}[]>} */
    async refresh(now = Date.now()) {
      const top = [...this.wallets].sort((a, b) => b[1] - a[1]).slice(0, this.maxWallets).map(([a]) => a);
      const stops = [];
      for (const user of top) {
        try {
          const orders = await getJson(this.fetch, "https://api.hyperliquid.xyz/info", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type: "frontendOpenOrders", user }) });
          for (const o of orders) {
            if (o.coin !== "BTC" || !o.isTrigger || !String(o.orderType).includes("Stop") || !(+o.sz > 0)) continue;
            stops.push({ px: +o.triggerPx, usd: +o.sz * +o.triggerPx, side: o.side === "B" ? "buy" : "sell" });
          }
        } catch (e) { this.errors++; }
        if (this.spacingMs) await this.sleep(this.spacingMs);
      }
      this.stops = stops.sort((a, b) => b.usd - a.usd).slice(0, this.top);
      this.at = now;
      return this.stops;
    }
  }

  // ───────────────────────────── 9. derive ─────────────────────────────

  const sumRows = (rows, key) => rows.reduce((s, r) => s + r[key], 0);

  function lean(share) {
    if (share == null) return "none";
    return share >= 0.55 ? "buyers" : share <= 0.45 ? "sellers" : "balanced";
  }

  /**
   * Numbers the UIs show, from a FlowState. Windows end at the last complete second.
   * @param {object} state FlowState
   * @param {number} windowMs 5, 12 or 20 minutes
   */
  function derive(state, windowMs) {
    const rows = state.seconds || [];
    const end = rows.length ? rows[rows.length - 1].t + 1000 : state.now;
    const since = (ms) => rows.slice(Math.max(0, lowerBound(rows, end - ms)));
    const m1 = since(MIN), win = since(windowMs), s10 = since(10_000);
    const buy = sumRows(m1, "perpBuy"), sell = sumRows(m1, "perpSell"), tot = buy + sell;
    const share = tot > 0 ? buy / tot : null;
    const u = state.usual || {};
    const vol1m = u.vol1mLive != null ? u.vol1mLive : u.vol1m;
    const xUsual = vol1m > 0 ? tot / vol1m : null;
    const spotB = sumRows(m1, "spotBuy"), spotS = sumRows(m1, "spotSell");
    return {
      flow1m: { buy, sell, total: tot, share, xUsual, hot: xUsual != null && xUsual >= 2 },
      spot1m: { buy: spotB, sell: spotS },
      net: { perp: sumRows(win, "perpBuy") - sumRows(win, "perpSell"), spot: sumRows(win, "spotBuy") - sumRows(win, "spotSell"), spanSec: win.length },
      makers10s: makers10(s10),
      read: { lean: lean(share), share, spot: spotRead(lean(share), spotB, spotS, tot), oi: oiRead(state.oi) },
      window: windowStats(win, state.prints || [], end, windowMs),
    };
  }

  /** First index with t >= target (rows sorted by t). */
  function lowerBound(rows, target) {
    let lo = 0, hi = rows.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (rows[mid].t < target) lo = mid + 1; else hi = mid; }
    return lo;
  }

  function makers10(rows) {
    const s = (k) => rows.reduce((a, r) => a + ((r.makers && r.makers[k]) || 0), 0);
    return { bidNet: s("bidPulled") - s("bidAdded"), askNet: s("askPulled") - s("askAdded"), bidQuoted: s("bidPulled") + s("bidAdded"), askQuoted: s("askPulled") + s("askAdded") };
  }

  function spotRead(perpLean, spotB, spotS, perpTot) {
    if (perpLean !== "buyers" && perpLean !== "sellers") return null;
    if (spotB + spotS < 0.01 * perpTot) return "quiet";
    const s = lean((spotB + spotS) > 0 ? spotB / (spotB + spotS) : null);
    if (s === perpLean) return "following";
    return s === "balanced" ? "not following" : "other way";
  }

  function oiRead(oi) {
    if (!oi || oi.d5Pct == null) return null;
    return Math.abs(oi.d5Pct) < 0.03 ? "flat" : oi.d5Pct > 0 ? "rising" : "falling";
  }

  function windowStats(win, prints, end, windowMs) {
    const inWin = prints.filter((p) => p.t > end - windowMs && p.t <= end);
    let biggest = null;
    for (const p of inWin) if (!biggest || p.usd > biggest.usd) biggest = p;
    return {
      perpBought: sumRows(win, "perpBuy"), perpSold: sumRows(win, "perpSell"), biggest,
      prints1m: inWin.filter((p) => p.usd >= HUGE_USD).length, sweeps: win.reduce((s, r) => s + (r.sweeps || 0), 0),
    };
  }

  // ───────────────────────────── 10. websocket connection ─────────────────────────────

  const realClock = () => ({
    now: () => Date.now(),
    setTimeout: (f, ms) => setTimeout(f, ms), clearTimeout: (id) => clearTimeout(id),
    setInterval: (f, ms) => setInterval(f, ms), clearInterval: (id) => clearInterval(id),
  });

  /**
   * One websocket: subscribe on open, app-level ping, stale watchdog, reconnect with backoff
   * (1 s, 2 s, 4 s ... capped at 30 s; reset once a session delivers data).
   * Status: "connecting" until the first JSON message, then "live"; "down" while waiting to retry.
   */
  class FeedConnection {
    /**
     * @param {{spec: object, WebSocket: Function, clock?: object, onMessage: Function, onStatus?: Function, log?: Function}} o
     */
    constructor({ spec, WebSocket, clock = realClock(), onMessage, onStatus = () => {}, log = () => {} }) {
      Object.assign(this, { spec, WS: WebSocket, clock, onMessage, onStatusCb: onStatus, log });
      this.status = null; this.ws = null; this.attempt = 0; this.stopped = true; this.timers = {};
      this.openedAt = 0; this.lastMsg = 0; this.stats = { msgs: 0, bytes: 0, reconnects: 0 }; this.outageSince = null;
    }

    start() { this.stopped = false; this.outageSince = this.clock.now(); this.connect(); }

    /**
     * Status for display: "connecting" until the first message, and for 15 s after a live socket drops
     * (retries included); "down" after that until data flows again.
     */
    health(now) {
      if (this.status === "live") return "live";
      return this.outageSince != null && now - this.outageSince < CONNECT_GRACE_MS ? "connecting" : "down";
    }

    /** Close quietly and for good. Safe to call twice; a socket still connecting is closed once it opens. */
    stop() {
      if (this.stopped && !this.ws) return;
      this.stopped = true;
      this.clearTimers(true);
      const ws = this.ws;
      this.ws = null;
      if (!ws) return;
      ws.onclose = null; ws.onmessage = null; ws.onerror = () => {};
      const closeQuietly = () => { try { ws.close(); } catch (e) { /* already closing: nothing to do */ } };
      if (ws.readyState === 0) ws.onopen = closeQuietly; else closeQuietly();
    }

    /** Send an object (JSON) or a raw string if the socket is open. */
    send(payload) {
      if (!this.ws || this.ws.readyState !== 1) return false;
      this.ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
      return true;
    }

    setStatus(s) { if (s !== this.status) { this.status = s; this.onStatusCb(s); } }

    async connect() {
      this.setStatus("connecting");
      let url;
      try { url = this.spec.urlFactory ? await this.spec.urlFactory() : this.spec.url; } catch (e) { this.fail(`url: ${e && e.message}`); return; }
      if (this.stopped) return;
      let ws;
      try { ws = new this.WS(url); } catch (e) { this.fail(`open: ${e && e.message}`); return; }
      this.ws = ws;
      this.lastMsg = this.clock.now();
      ws.onopen = () => this.onOpen();
      ws.onmessage = (ev) => this.onData(ev.data);
      ws.onerror = () => {};
      ws.onclose = () => this.onClose();
      this.timers.watch = this.clock.setInterval(() => this.watchdog(), Math.min(5000, this.spec.staleMs || 60_000));
    }

    onOpen() {
      this.openedAt = this.clock.now();
      for (const sub of this.spec.subs || []) this.send(typeof sub === "function" ? sub() : sub);
      if (this.spec.ping && this.spec.pingEveryMs) {
        this.timers.ping = this.clock.setInterval(() => this.send(typeof this.spec.ping === "function" ? this.spec.ping() : this.spec.ping), this.spec.pingEveryMs);
      }
    }

    onData(data) {
      const recv = this.clock.now();
      this.lastMsg = recv;
      if (typeof data !== "string") return;
      this.stats.msgs++; this.stats.bytes += data.length;
      if (data[0] !== "{" && data[0] !== "[") return; // text pong
      let msg;
      try { msg = JSON.parse(data); } catch (e) { this.log(`${this.spec.key}: bad JSON`); return; }
      if (this.status !== "live") { this.attempt = 0; this.outageSince = null; this.setStatus("live"); }
      this.onMessage(msg, recv);
    }

    watchdog() {
      if (this.ws && this.clock.now() - this.lastMsg >= (this.spec.staleMs || 60_000)) {
        this.log(`${this.spec.key}: stale, reconnecting`);
        this.ws.close();
      }
    }

    onClose() {
      this.clearTimers(false);
      this.ws = null;
      if (this.stopped) return;
      this.retry();
    }

    fail(why) {
      this.log(`${this.spec.key}: ${why}`);
      this.clearTimers(false);
      if (!this.stopped) this.retry();
    }

    retry() {
      if (this.status === "live" || this.outageSince == null) this.outageSince = this.clock.now();
      this.setStatus("down");
      this.stats.reconnects++;
      const delay = Math.min(30_000, 1000 * 2 ** this.attempt);
      this.attempt = Math.min(this.attempt + 1, 10);
      this.timers.retry = this.clock.setTimeout(() => { this.timers.retry = null; if (!this.stopped) this.connect(); }, delay);
    }

    clearTimers(all) {
      if (this.timers.ping) this.clock.clearInterval(this.timers.ping);
      if (this.timers.watch) this.clock.clearInterval(this.timers.watch);
      this.timers.ping = this.timers.watch = null;
      if (all && this.timers.retry) { this.clock.clearTimeout(this.timers.retry); this.timers.retry = null; }
    }
  }

  // ───────────────────────────── 11. feed specs ─────────────────────────────

  /**
   * Every websocket the engine opens. `venues` = venue names whose status this socket drives.
   * `parse` = trade parser key. `book` = optional book adapter factory (onLevel, onGap) -> adapter.
   * Phone mode: Binance top-20 depth every 500 ms instead of the full diff stream, no Bybit book (orderbook.50
   * pushes every 20 ms, measured 30 KB/s, the heaviest phone stream), Hyperliquid coarse ($100) book only, no OKX books, no REST book snapshots.
   * All trade streams stay. Phone makers and walls therefore only see levels near the touch.
   */
  function buildFeeds({ phone = false, proxyBase = null, fetch = null, books = true } = {}) {
    const okxBooks = books && !phone;
    const sec = () => Math.floor(Date.now() / 1000);
    const feeds = [
      { key: "hyperliquid", venues: ["Hyperliquid"], parse: "hyperliquid", url: "wss://api.hyperliquid.xyz/ws",
        subs: [{ method: "subscribe", subscription: { type: "trades", coin: "BTC" } }, ...(books && !phone ? [{ method: "subscribe", subscription: { type: "l2Book", coin: "BTC", nSigFigs: 4 } }] : [])],
        ping: { method: "ping" }, pingEveryMs: 30_000, staleMs: 90_000,
        book: books && !phone ? (o) => new HlBook({ venue: "Hyperliquid", ...o }) : null },
      ...(books ? [{ key: "hyperliquidCoarse", venues: [], parse: null, url: "wss://api.hyperliquid.xyz/ws",
        subs: [{ method: "subscribe", subscription: { type: "l2Book", coin: "BTC", nSigFigs: 3 } }],
        ping: { method: "ping" }, pingEveryMs: 30_000, staleMs: 120_000,
        book: (o) => { const b = new HlBook({ venue: "Hyperliquid", ...o, onLevel: () => {} }); b.deep = true; return b; } }] : []),
      { key: "binance", venues: ["Binance"], parse: "binance", url: "wss://fstream.binance.com/market/stream?streams=btcusdt@aggTrade/btcusdc@aggTrade", staleMs: 60_000 },
      { key: "binanceCoinm", venues: ["Binance"], parse: "binanceCoinm", url: "wss://dstream.binance.com/market/ws/btcusd_perp@trade", staleMs: 180_000 },
      ...(books ? [{ key: "binanceDepth", venues: [], parse: null, url: `wss://fstream.binance.com/public/ws/btcusdt@${phone ? "depth20@500ms" : "depth@100ms"}`, staleMs: 30_000,
        book: (o) => (phone ? new BinancePartialBook({ venue: "Binance", ...o }) : new BinanceDepthBook({ venue: "Binance", ...o })) }] : []),
      { key: "binanceSpot", venues: ["Binance spot"], parse: "binanceSpot", url: "wss://stream.binance.com:9443/ws/btcusdt@aggTrade", staleMs: 60_000 },
      { key: "bybit", venues: ["Bybit"], parse: "bybit", url: "wss://stream.bybit.com/v5/public/linear",
        subs: [{ op: "subscribe", args: ["publicTrade.BTCUSDT", "publicTrade.BTCPERP", ...(books && !phone ? ["orderbook.1000.BTCUSDT"] : [])] }],
        ping: { op: "ping" }, pingEveryMs: 20_000, staleMs: 60_000,
        book: books && !phone ? (o) => new BybitBook({ venue: "Bybit", symbol: "BTCUSDT", ...o }) : null },
      { key: "bybitInverse", venues: ["Bybit"], parse: "bybit", url: "wss://stream.bybit.com/v5/public/inverse",
        subs: [{ op: "subscribe", args: ["publicTrade.BTCUSD"] }], ping: { op: "ping" }, pingEveryMs: 20_000, staleMs: 90_000 },
      { key: "bybitSpot", venues: ["Bybit spot"], parse: "bybitSpot", url: "wss://stream.bybit.com/v5/public/spot",
        subs: [{ op: "subscribe", args: ["publicTrade.BTCUSDT"] }], ping: { op: "ping" }, pingEveryMs: 20_000, staleMs: 60_000 },
      { key: "okx", venues: ["OKX", "OKX spot"], parse: "okx", url: "wss://ws.okx.com/ws/v5/public",
        subs: [{ op: "subscribe", args: [...["BTC-USDT-SWAP", "BTC-USD-SWAP", "BTC-USDT"].map((i) => ({ channel: "trades", instId: i })), ...(okxBooks ? [{ channel: "books", instId: "BTC-USDT-SWAP" }] : [])] }],
        ping: "ping", pingEveryMs: 20_000, staleMs: 60_000,
        book: okxBooks ? (o) => new OkxBook({ venue: "OKX", instId: "BTC-USDT-SWAP", ctVal: OKX_USDT_SWAP_BTC, ...o }) : null,
        resubscribeBook: [{ op: "unsubscribe", args: [{ channel: "books", instId: "BTC-USDT-SWAP" }] }, { op: "subscribe", args: [{ channel: "books", instId: "BTC-USDT-SWAP" }] }] },
      { key: "gate", venues: ["Gate"], parse: "gate", url: "wss://fx-ws.gateio.ws/v4/ws/usdt",
        subs: [() => ({ time: sec(), channel: "futures.trades", event: "subscribe", payload: ["BTC_USDT"] })],
        ping: () => ({ time: sec(), channel: "futures.ping" }), pingEveryMs: 20_000, staleMs: 60_000 },
      { key: "bitget", venues: ["Bitget"], parse: "bitget", url: "wss://ws.bitget.com/v2/ws/public",
        subs: [{ op: "subscribe", args: [{ instType: "USDT-FUTURES", channel: "trade", instId: "BTCUSDT" }, { instType: "USDC-FUTURES", channel: "trade", instId: "BTCPERP" }] }],
        ping: "ping", pingEveryMs: 25_000, staleMs: 60_000 },
      { key: "aster", venues: ["Aster"], parse: "aster", url: "wss://fstream.asterdex.com/ws/btcusdt@aggTrade", staleMs: 240_000 },
      { key: "deribit", venues: ["Deribit"], parse: "deribit", url: "wss://www.deribit.com/ws/api/v2",
        subs: [{ jsonrpc: "2.0", id: 1, method: "public/subscribe", params: { channels: ["trades.BTC-PERPETUAL.100ms", "trades.BTC_USDC-PERPETUAL.100ms"] } }],
        ping: { jsonrpc: "2.0", id: 9, method: "public/test" }, pingEveryMs: 20_000, staleMs: 60_000 },
      { key: "extended", venues: ["Extended"], parse: "extended", url: "wss://api.starknet.extended.exchange/stream.extended.exchange/v1/publicTrades/BTC-USD", staleMs: 240_000 },
      { key: "mexc", venues: ["MEXC"], parse: "mexc", url: "wss://contract.mexc.com/edge",
        subs: [{ method: "sub.deal", param: { symbol: "BTC_USDT" } }], ping: { method: "ping" }, pingEveryMs: 15_000, staleMs: 60_000 },
      { key: "pacifica", venues: ["Pacifica"], parse: "pacifica", url: "wss://ws.pacifica.fi/ws",
        subs: [{ method: "subscribe", params: { source: "trades", symbol: "BTC" } }], ping: { method: "ping" }, pingEveryMs: 20_000, staleMs: 90_000 },
      { key: "coinbase", venues: ["Coinbase"], parse: "coinbase", url: "wss://advanced-trade-ws.coinbase.com",
        subs: [{ type: "subscribe", product_ids: ["BTC-USD"], channel: "market_trades" }], staleMs: 60_000 },
      { key: "kraken", venues: ["Kraken"], parse: "kraken", url: "wss://ws.kraken.com/v2",
        subs: [{ method: "subscribe", params: { channel: "trade", symbol: ["BTC/USD"], snapshot: false } }], ping: { method: "ping" }, pingEveryMs: 20_000, staleMs: 60_000 },
    ];
    if (proxyBase && fetch) {
      feeds.push({ key: "kucoin", venues: ["KuCoin"], parse: "kucoin", url: null, urlFactory: () => kucoinUrl(fetch, proxyBase),
        subs: [{ id: "1", type: "subscribe", topic: "/contractMarket/execution:XBTUSDTM", response: true }],
        ping: () => ({ id: String(Date.now()), type: "ping" }), pingEveryMs: 15_000, staleMs: 60_000 });
    }
    return feeds;
  }

  /**
   * REST book refreshes. Desktop: Binance depth 1000 re-snapshot every 30 s (live diff chain kept), OKX
   * books-full (5000 levels, about 230 KB) every 30 s as a deep layer. Phone: neither (Binance snapshot only on sync).
   */
  function REST_BOOKS({ phone = false } = {}) {
    return { binanceEveryMs: phone ? null : 30_000, okxDeep: !phone, okxDeepEveryMs: 30_000 };
  }

  /** KuCoin futures public websocket URL; the token endpoint is POST-only and has no CORS, so it goes via the proxy. */
  async function kucoinUrl(fetchFn, proxyBase) {
    const j = await getJson(fetchFn, proxied(proxyBase, "https://api-futures.kucoin.com/api/v1/bullet-public"), { method: "POST" });
    return `${j.data.instanceServers[0].endpoint}?token=${j.data.token}`;
  }

  // ───────────────────────────── 12. the engine ─────────────────────────────

  const STATUS_RANK = { live: 0, connecting: 1, down: 2 };
  const CONNECT_GRACE_MS = 15_000;
  const TICK_MS = 250;

  /**
   * The live engine. Public API: start(), stop(), state(), subscribe(fn) -> unsubscribe, derive(windowMs),
   * stats(). tick(now) is called internally every 250 ms (exposed for tests and harnesses).
   */
  class FlowEngine {
    /**
     * @param {object} [opts]
     * @param {boolean} [opts.phone=false] lighter book streams, no HL stop scan
     * @param {string|null} [opts.proxyBase=null] base URL of the Mac dash server offering /proxy?u= (GET and POST)
     * @param {boolean} [opts.books=true] subscribe order books (ladder, makers, walls, fuel cover)
     * @param {boolean} [opts.hlStops] scan Hyperliquid stops (default: not in phone mode)
     * @param {Function} [opts.WebSocket] WebSocket constructor (default global)
     * @param {Function} [opts.fetch] fetch (default global)
     * @param {object} [opts.clock] {now, setTimeout, clearTimeout, setInterval, clearInterval}
     * @param {Function} [opts.log] warning sink (default console.warn)
     */
    constructor(opts = {}) {
      const g = typeof globalThis !== "undefined" ? globalThis : {};
      this.o = { phone: false, proxyBase: null, books: true, WebSocket: g.WebSocket, fetch: g.fetch ? g.fetch.bind(g) : null, clock: realClock(), log: (m) => console.warn(`[flow-engine] ${m}`), ...opts };
      if (this.o.hlStops === undefined) this.o.hlStops = !this.o.phone;
      this.clock = this.o.clock;
      this.seconds = new SecondsStore();
      this.prints = new PrintTape();
      this.sweeps = new SweepDetector();
      this.dedup = new Deduper();
      this.hub = new BookHub();
      this.walls = new WallDetector();
      this.pushes = new PushDetector();
      this.wallEvents = []; this.pushList = [];
      this.oiTracker = new OiTracker();
      this.oiFeed = new OiFeed({ fetch: this.o.fetch, proxyBase: this.o.proxyBase });
      this.usual = new UsualVolume(this.o.usualStorage !== undefined ? { storage: this.o.usualStorage } : {});
      this.usualFeed = new UsualFeed({ fetch: this.o.fetch });
      this.fuelFeed = new FuelFeed({ fetch: this.o.fetch, proxyBase: this.o.proxyBase });
      this.stops = new StopsTracker({ fetch: this.o.fetch });
      this.fuelBars = null; this.fuelWithOkx = false; this.fuelState = null;
      this.px = 0; this.binancePx = 0; this.lag = new Map(); this.listeners = new Set();
      this.feeds = []; this.conns = new Map(); this.adapters = new Map(); this.timers = []; this.busy = {}; this.nextTry = {};
      this.running = false; this.resumedAt = null; this.lastTickAt = null; this.lags = []; this.gaps = new SeqGaps();
      this.cached = null; this.hist = { lastAt: -Infinity, book: [], fuel: [], oi: [] }; this.counters = { stale: 0, dupes: 0, parseErrors: 0 };
    }

    /** Open every socket and start the timers. A no-op if running. After stop(), the stopped time becomes a gap. */
    start() {
      if (this.running) return;
      this.running = true;
      const now = this.clock.now();
      if (this.seconds.lastClosed !== null) {
        this.seconds.skipTo(Math.floor(now / 1000) - 1);
        this.sweeps = new SweepDetector();
        this.pushes.win = [];
        this.hub.makers.clear();
        this.resumedAt = now;
      }
      this.feeds = buildFeeds({ phone: this.o.phone, proxyBase: this.o.proxyBase, fetch: this.o.fetch, books: this.o.books });
      for (const feed of this.feeds) this.startFeed(feed);
      const c = this.clock;
      this.timers.push(c.setInterval(() => this.tick(c.now()), TICK_MS));
      this.timers.push(c.setInterval(() => this.pollOi(), this.o.phone ? 30_000 : 15_000));
      const rb = REST_BOOKS({ phone: this.o.phone });
      if (this.o.books && rb.okxDeep) {
        this.okxDeep = new OkxDeepBook({ venue: "OKX", ctVal: OKX_USDT_SWAP_BTC });
        this.hub.attach(this.okxDeep);
        this.timers.push(c.setInterval(() => this.loadOkxDeep(), rb.okxDeepEveryMs));
        this.loadOkxDeep();
      }
      if (this.o.books && rb.binanceEveryMs) this.timers.push(c.setInterval(() => { const a = this.adapters.get("binanceDepth"); if (a) a.beginResync(); }, rb.binanceEveryMs));
      this.timers.push(c.setInterval(() => this.refreshFuel(), 40_000));
      this.timers.push(c.setInterval(() => this.checkUsual(), 60_000));
      if (this.o.hlStops) this.timers.push(c.setInterval(() => this.refreshStops(), 15 * MIN));
      this.checkUsual(); this.seedOi(); this.pollOi(); this.refreshFuel();
      if (this.o.hlStops) this.timers.push(c.setTimeout(() => this.refreshStops(), 2 * MIN));
    }

    startFeed(feed) {
      const conn = new FeedConnection({ spec: feed, WebSocket: this.o.WebSocket, clock: this.clock, log: this.o.log,
        onMessage: (msg, recv) => this.onMessage(feed, conn, msg, recv), onStatus: (s) => this.onStatus(feed, s) });
      if (feed.book) {
        const adapter = feed.book({ onLevel: (...a) => this.hub.onLevel(...a), onGap: () => feed.resubscribeBook.forEach((m) => conn.send(m)) });
        this.adapters.set(feed.key, adapter);
        this.hub.attach(adapter);
      }
      this.conns.set(feed.key, conn);
      conn.start();
    }

    /** Close every socket and stop all timers. Safe to call more than once. */
    stop() {
      if (!this.running) return;
      this.running = false;
      for (const t of this.timers) { this.clock.clearInterval(t); this.clock.clearTimeout(t); }
      this.timers = [];
      for (const conn of this.conns.values()) conn.stop();
    }

    /** @param {(state: object) => void} fn called with each new FlowState. @returns {() => void} unsubscribe */
    subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

    /** Current FlowState (built at the last tick). */
    state() { return this.cached || this.buildState(this.clock.now()); }

    /** derive() on the current state. */
    derive(windowMs) { return derive(this.state(), windowMs); }

    /** Per-socket message counts, bytes, reconnects and status (for phone-mode costing and debugging). */
    stats() {
      const out = {};
      for (const [k, c] of this.conns) out[k] = { status: c.status, ...c.stats };
      return { feeds: out, counters: { ...this.counters, late: this.seconds.late } };
    }

    onStatus(feed, status) {
      if (status === "connecting") for (const v of feed.venues) this.gaps.reset(v);
      if (status === "connecting" && this.adapters.has(feed.key)) {
        const a = this.adapters.get(feed.key);
        a.reset();
        if (!a.deep) this.walls.forget(a.venue);
      }
    }

    onMessage(feed, conn, msg, recv) {
      const adapter = this.adapters.get(feed.key);
      if (adapter && adapter.handle(msg, recv)) return;
      if (!feed.parse) return;
      let trades;
      try { trades = parsers[feed.parse](msg, recv); } catch (e) { this.counters.parseErrors++; this.o.log(`${feed.key}: parse error ${e && e.message}`); return; }
      for (const t of trades) {
        if (t.ts < conn.openedAt - 2000) { this.counters.stale++; continue; }
        if (this.dedup.seen(t)) { this.counters.dupes++; continue; }
        this.ingest(t, feed.key);
      }
    }

    ingest(t, feedKey) {
      this.gaps.add(t);
      this.seconds.add(t); this.prints.add(t); this.sweeps.add(t); this.usual.onTrade(t);
      this.hub.onTrade(t); this.walls.onTrade(t);
      if (t.kind === "perp") {
        if (t.venue === "Binance" && t.inst === "BTCUSDT") this.binancePx = t.px;
        this.px = this.binancePx || t.px;
        this.hub.setPrice(this.px);
      }
      if (t.user && t.usd >= BIG_USD) this.stops.noteWallet(t.user, t.usd);
      const l = this.lag.get(feedKey), d = Math.max(0, t.recv - t.ts);
      this.lag.set(feedKey, l == null ? d : l + 0.05 * (d - l));
    }

    /** Close complete seconds, run walls/pushes, publish. Called every 250 ms. */
    tick(now) {
      this.noteLoopLag(now);
      const through = Math.floor((now - 100) / 1000) - 1;
      if (this.seconds.lastClosed !== null && through <= this.seconds.lastClosed) return;
      const sweeps = this.sweeps.finalizeThrough(through);
      const bySec = new Map();
      for (const s of sweeps) (bySec.get(s.sec) || bySec.set(s.sec, []).get(s.sec)).push(s);
      for (const row of this.seconds.finalizeThrough(through)) {
        const sec = row.t / 1000, sw = bySec.get(sec) || [];
        row.makers = this.hub.makersFor(sec);
        row.makersOk = this.anyBookReady();
        row.sweeps = sw.length;
        const push = this.pushes.update(row, sw);
        if (push) this.pushList.push(push);
      }
      this.runWalls(now);
      this.wallEvents.sort((a, b) => a.t - b.t);
      this.maintainBooks(now);
      this.prints.prune(now);
      pruneByT(this.wallEvents, now - EVENT_KEEP_MS);
      pruneByT(this.pushList, now - EVENT_KEEP_MS);
      this.cached = this.buildState(now);
      this.recordHistory(now, this.cached);
      this.cached.history = this.historyView();
      for (const fn of this.listeners) {
        try { fn(this.cached); } catch (e) { this.o.log(`subscriber failed: ${e && e.message}`); }
      }
    }

    /** Track how late ticks run (event loop busy): worst delay beyond the 250 ms cadence over the last 10 s. */
    noteLoopLag(now) {
      if (this.lastTickAt != null) this.lags.push([now, Math.max(0, now - this.lastTickAt - TICK_MS)]);
      this.lastTickAt = now;
      while (this.lags.length && this.lags[0][0] < now - 10_000) this.lags.shift();
    }

    loopLagMs() { return this.lags.reduce((m, [, l]) => Math.max(m, l), 0); }

    anyBookReady() { for (const a of this.adapters.values()) if (a.ready && !a.deep) return true; return false; }

    /**
     * Replay history: every 5 s a book snapshot (20 rows around price) and the current OI; fuel when it
     * was recomputed. 20 minutes kept. Nothing is recorded while a value is null.
     */
    recordHistory(now, st) {
      const h = this.hist;
      if (now - h.lastAt >= 5000) {
        h.lastAt = now;
        if (st.book) { const mid = this.hub.halfRows; h.book.push({ at: now, step: st.book.step, rows: st.book.rows.slice(mid - 10, mid + 10) }); }
        if (st.oi) h.oi.push(st.oi);
        if (st.fuel && (!h.fuel.length || h.fuel[h.fuel.length - 1].at !== st.fuel.at)) h.fuel.push(st.fuel);
      }
      for (const k of ["book", "oi", "fuel"]) { let i = 0; while (i < h[k].length && h[k][i].at < now - HISTORY_KEEP_MS) i++; if (i) h[k].splice(0, i); }
    }

    historyView() { return { book: this.hist.book.slice(), fuel: this.hist.fuel.slice(), oi: this.hist.oi.slice() }; }

    runWalls(now) {
      if (!this.px) return;
      for (const a of this.adapters.values()) {
        if (!a.ready || a.deep) continue;
        this.wallEvents.push(...this.walls.update(a.venue, this.hub.venueBuckets(a.venue, this.px, this.walls.bandPct), this.px, now));
      }
    }

    /** Binance depth snapshots (on demand) and pruning far levels every 10 s. */
    maintainBooks(now) {
      const bn = this.adapters.get("binanceDepth"), conn = this.conns.get("binanceDepth");
      if (bn && bn.needsSnapshot && conn && conn.status === "live" && !this.busy.depth && now >= (this.nextTry.depth || 0)) this.loadDepthSnapshot(bn);
      if (this.px && Math.floor(now / 1000) % 10 === 0) this.hub.prune(this.px);
    }

    async loadOkxDeep() {
      if (this.busy.okxDeep) return;
      this.busy.okxDeep = true;
      try { this.okxDeep.applyRest(await getJson(this.o.fetch, "https://www.okx.com/api/v5/market/books-full?instId=BTC-USDT-SWAP&sz=5000")); } catch (e) { this.o.log(`OKX deep book failed: ${e && e.message}`); } finally { this.busy.okxDeep = false; }
    }

    async loadDepthSnapshot(adapter) {
      this.busy.depth = true;
      try {
        const snap = await getJson(this.o.fetch, `https://fapi.binance.com/fapi/v1/depth?symbol=BTCUSDT&limit=${this.o.phone ? 500 : 1000}`);
        adapter.applySnapshot(snap, this.clock.now());
      } catch (e) {
        this.o.log(`binance depth snapshot failed: ${e && e.message}`);
        this.nextTry.depth = this.clock.now() + 5000;
      } finally { this.busy.depth = false; }
    }

    buildState(now) {
      const statuses = this.venueStatuses();
      const live = statuses.filter((v) => v.status === "live").length, blocked = statuses.filter((v) => v.status === "blocked").length;
      const oi = this.oiTracker.snapshot(now);
      const u = this.usual.value(now, new Set(statuses.filter((v) => v.kind === "perp" && v.status === "live").map((v) => v.name)));
      const anyBook = this.anyBookReady();
      return {
        now, coin: "BTC", px: this.px, venues: statuses,
        seconds: this.seconds.rows().slice(), prints: this.prints.list().slice(), walls: this.wallEvents.slice(), pushes: this.pushList.slice(),
        book: anyBook && this.px ? this.hub.ladder(this.px, now) : null,
        fuel: this.fuelState, oi, usual: { vol1m: u.vol1m, asOf: u.asOf, vol1mLive: u.vol1mLive, coverage: u.coverage },
        health: { connected: live, total: statuses.length, blocked, lagMs: Math.round(median(this.liveLags())), resumedAt: this.resumedAt, loopLagMs: this.loopLagMs(), missed: this.gaps.all(now) },
        history: this.historyView(),
      };
    }

    liveLags() {
      const out = [];
      for (const [k, v] of this.lag) if (this.conns.get(k) && this.conns.get(k).status === "live") out.push(v);
      return out;
    }

    /** Venue status = worst status of its sockets; Lighter blocked; KuCoin down without a proxy. */
    venueStatuses() {
      return VENUES.map(({ name, kind }) => {
        if (name === "Lighter") return { name, kind, status: "blocked" };
        let status = null;
        for (const f of this.feeds) {
          if (!f.venues.includes(name)) continue;
          const c = this.conns.get(f.key), s = c ? c.health(this.clock.now()) : "connecting";
          if (status === null || STATUS_RANK[s] > STATUS_RANK[status]) status = s;
        }
        return { name, kind, status: status || "down" };
      });
    }

    // REST loops: each catches its own errors, logs, and leaves the previous value in place.

    async seedOi() {
      try {
        const seeds = await this.oiFeed.seed();
        for (const [key, pts] of Object.entries(seeds)) this.oiTracker.seed(key, pts);
      } catch (e) { this.o.log(`OI seed failed: ${e && e.message}`); }
    }

    async pollOi() {
      if (this.busy.oi) return;
      this.busy.oi = true;
      try {
        const now = this.clock.now();
        for (const r of await this.oiFeed.poll()) this.oiTracker.ingest(r.venue, now, r.coin, r.usd, r.funding8h, r.parts);
        for (const [v, n] of Object.entries(this.oiFeed.errors)) if (n) this.o.log(`OI ${v} failed ${n}x: ${this.oiFeed.lastError[v]}`);
        this.oiFeed.errors = {};
      } finally { this.busy.oi = false; }
    }

    async checkUsual() {
      const now = this.clock.now(), hour = new Date(now).getUTCHours();
      if (this.busy.usual || (this.usual.hour === hour && this.usual.base != null)) return;
      this.busy.usual = true;
      try { this.usual.setBaseline(hour, await this.usualFeed.minuteVolumes(now), now); } catch (e) { this.o.log(`usual volume failed: ${e && e.message}`); } finally { this.busy.usual = false; }
    }

    /** Refetch bars every 5 min (72 h backfill), recompute clusters and cover every call (40 s). */
    async refreshFuel() {
      if (this.busy.fuel) return;
      this.busy.fuel = true;
      try {
        const now = this.clock.now();
        if (!this.fuelBars || now - this.fuelBarsAt >= 5 * MIN) {
          const res = await this.fuelFeed.bars(now - 72 * HOUR, now);
          this.fuelBars = res.bars; this.fuelWithOkx = res.withOkx; this.fuelBarsAt = now;
        }
        if (this.px) this.fuelState = { at: now, model: "ours-partial", levels: clusters(this.fuelBars, now, this.px, this.fuelConfig(), this.hub.levels(this.px)), stops: Array.isArray(this.stops.stops) ? this.stops.stops.slice() : [] };
      } catch (e) { this.o.log(`fuel failed: ${e && e.message}`); } finally { this.busy.fuel = false; }
    }

    /**
     * The fit used Binance + Bybit + OKX OI. Without the proxy OKX history is missing, so the scale is
     * raised by (Binance + Bybit + OKX) / (Binance + Bybit) from live OI (default 1.2, measured 2026-11-14).
     */
    fuelConfig() {
      if (this.fuelWithOkx) return FUEL_CONFIG;
      const l = this.oiTracker.latest, bn = l.get("Binance"), by = l.get("Bybit"), ok = l.get("OKX");
      const comp = bn && by && ok ? (bn.coin + by.coin + ok.coin) / (bn.coin + by.coin) : 1.2;
      return { ...FUEL_CONFIG, oiScale: FUEL_CONFIG.oiScale * comp };
    }

    async refreshStops() {
      if (this.busy.stops) return;
      this.busy.stops = true;
      try {
        await this.stops.refresh(this.clock.now());
        if (this.stops.errors) this.o.log(`HL stops: ${this.stops.errors} wallet queries failed`);
        this.stops.errors = 0;
      } finally { this.busy.stops = false; }
    }
  }

  function pruneByT(list, minT) {
    let i = 0;
    while (i < list.length && list[i].t < minT) i++;
    if (i) list.splice(0, i);
  }

  /**
   * Create an engine (not started).
   * @param {object} [opts] see FlowEngine
   * @returns {FlowEngine}
   */
  function createEngine(opts) { return new FlowEngine(opts); }

  return {
    createEngine, FlowEngine, VENUES, BOOK_INST, BIG_USD, HUGE_USD, parsers, isoToMs,
    SecondsStore, Deduper, PrintTape, SweepDetector, SeqGaps,
    L2Book, BybitBook, OkxBook, OkxDeepBook, BinanceDepthBook, BinancePartialBook, HlBook, BookHub, REST_BOOKS,
    WallDetector, PushDetector, FUEL_CONFIG, fuel: { buildHeat, pickClusters, clusters, joinBars, emptyCurve, HeatCurve },
    FuelFeed, OiFeed, OiTracker, UsualVolume, DEFAULT_SHARES, USUAL_PRIOR_RATIO, UsualFeed, StopsTracker,
    derive, FeedConnection, buildFeeds, median,
  };
});

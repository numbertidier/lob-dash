# LOB desk

One-page phone dashboard for the desk's Hyperliquid sub-accounts, plus live BTC order flow.

- Book tab: today, since start, Sharpe, drawdown, red days, cumulative P&L, daily returns, positions.
- Order book tab: spread and depth for every held coin, and our size against exit-side depth.
- Flow tab: live BTC order flow across exchanges. See below.

Data comes live from public exchange APIs, fetched by the phone. The files hold no addresses or keys.
On first open of a P&L tab, paste the master address. It is kept in that browser only. The Flow tab needs no address.

Hosted with GitHub Pages. On iPhone: open the link in Safari, Share, Add to Home Screen.

Themes: Night, Day, Read (greyscale), Warm (no blue light), Mono (black, white and greys only).

## Flow tab

What it shows, top to bottom:

- The read: BTC price, who is in control (buyers or sellers), how hot the last minute is against a usual minute, and one sentence.
- Taker flow in the last minute, perps and spot apart, and by order size.
- Makers in the last 10 seconds: quotes pulled or added near price.
- Net flow since 5, 12 or 20 minutes ago, with price.
- Big prints ($100k and up), walls and pushes, the merged order book, liquidation fuel, open interest and funding, and every venue.

How it works:

- The phone connects to the exchanges directly (websockets and public REST). There is no server.
- Data use while the Flow tab is open: about 100 to 250 MB an hour in a busy market. Streams close 60 s after you leave the tab.
- It runs only while the Flow tab is open. After 60 seconds on another tab or with the app in the background it closes every connection. On return it starts fresh, so the first minute warms up again.
- Lighter blocks connections from our region. It always shows as blocked and is in no total.
- KuCoin is not on the phone. It needs a token from a server, which the phone does not have. It is about 1% of volume.
- On the phone the book reads fewer exchanges than the Mac (no OKX book), and Hyperliquid stops are not scanned.
- Fuel (liquidation clusters) is our own model. It is only a partial match to the reference feed. Read it as a map, not a fact.
- The "usual minute" is an estimate from Binance history, scaled to all venues.

Demo without live data: add `?sim=1` to the URL. It replays a recorded 20 minute session from `fixture.json`.

## Files

- `index.html`: the app, P&L tabs and glue.
- `flow.js`, `flow.css`: the Flow tab UI.
- `flow-engine.js`, `flow-shared.js`: the flow engine and shared rules. Vendored copies. Do not edit here.
  Refresh them with `tools/sync_flow.sh <path to flow_build>` (add `--fixture` to refresh `fixture.json` too).

## Tests

`node --test tests/` (flow lifecycle and the pure flow numbers).

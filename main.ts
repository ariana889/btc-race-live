// cbBTC/USDC mean-reversion bot for make.fun's btc-race-24h-20261117-0603.
//
// The replay hands one bar per minute: its open, high, low, close and the pool depth at its open and
// close. Signals read closes (highs and lows are information only: the replay fills at the next open,
// never at a high or a low), and a flat bar (open == close, nobody traded) never triggers an entry.
//
// What it does, and why:
//   - Costs are the whole game: a full-size round trip pays about 4 bps of fee twice, 2 bps of
//     modelled slippage twice and about 11 bps of price impact twice at this pool's depth, so ~35 bps
//     at 90% of equity. A trade has to expect clearly more than that or it is a loss by construction.
//   - The minute series is mean-reverting, not trending: most bars are flat, one-bar moves run to a
//     10 bps p95, and a dip below the hour's average comes back. So the core is a dip buyer: it buys
//     when the close sits a volatility-scaled distance below a 60-bar moving average, but only while
//     the 4-hour average has not been falling, so it does not buy into a slide that keeps sliding.
//   - It exits on a profit target comfortably above the round-trip cost, on a wide catastrophe stop
//     well past the dip it buys (a tight stop would sell exactly the lows it entered for), or after a
//     maximum hold, whichever comes first. No shorts, no leverage, cash only: one position at a time.
//   - Sizing is 90% of equity, capped by cash and by a small share of the pool depth at the latest
//     close, so an order never asks for more of the book than it can fill at the price it expects.
//
// Determinism: nothing reads the clock, the environment or Math.random; every decision is a pure
// function of the bars this run has been sent, and the arithmetic on them is plain IEEE double and
// exact bigint, so two runs on the same window answer with the same orders byte for byte.

import { runBars, type Bar, type BarsState, type OrderInput } from './vendor/makefun-bars.ts';

/** The short average a dip is measured against, and the bars its volatility is measured over. */
const SHORT_MA = 60;
const VOL_BARS = 60;
/** A dip must clear this many bps plus one sigma of the last VOL_BARS one-bar moves. */
const ENTRY_FLOOR_BPS = 65;
const ENTRY_SIGMAS = 1;
/** The long average the trend filter reads, how far back its slope is measured, and how far it may fall. */
const LONG_MA = 240;
const TREND_LAG = 60;
const TREND_DROP_BPS = 60;
/** Exit: profit target over the position's cost, catastrophe stop, and the longest hold in bars. */
const TARGET_BPS = 95;
const STOP_BPS = 120;
const MAX_HOLD_BARS = 300;
/** No decision before this many bars: the averages above must be warm and the first minutes are noise. */
const MIN_BARS = 70;
/** Equity put at risk per position, in bps of equity. */
const SIZE_BPS = 9000;
/** Never ask for more than this fraction of the pool depth at the latest close. */
const DEPTH_SHARE = 50n;
/** Orders allow this much move from the close they were decided on (slippage and impact included). */
const MAX_SLIPPAGE_BPS = 120;

interface Series {
  /** Bar closes, oldest first. */
  closes: number[];
  /** Pool depth at each bar's close, in quote units. */
  depths: bigint[];
  /** The bar index the current position was bought at, or -1 while flat. */
  entryIndex: number;
  /** The bar index of the last bar folded in. */
  index: number;
}

const series = new Map<string, Series>();

function push(state: BarsState, bar: Bar): void {
  let s = series.get(bar.symbol);
  if (s === undefined) series.set(bar.symbol, (s = { closes: [], depths: [], entryIndex: -1, index: -1 }));
  s.closes.push(Number(bar.c));
  // Depth arrives in USDC raw units (10^-6); the quote amounts here are at the capital's own scale.
  const scale = 10n ** BigInt(state.hello.capital.quote_scale);
  s.depths.push((BigInt(bar.c_depth[0] ?? '0') * scale) / 1_000_000n);
  s.index += 1;
}

/** The mean of the last `len` closes ending at `i`, or null before it holds that many. */
function mean(s: Series, i: number, len: number): number | null {
  if (i - len + 1 < 0) return null;
  let sum = 0;
  for (let j = i - len + 1; j <= i; j++) sum += s.closes[j]!;
  return sum / len;
}

/** The population standard deviation, in bps, of the last VOL_BARS one-bar returns ending at `i`. */
function volatility(s: Series, i: number): number {
  const from = i - VOL_BARS + 1;
  const start = from < 1 ? 1 : from;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let j = start; j <= i; j++) {
    const prev = s.closes[j - 1]!;
    if (prev === 0) continue;
    const r = ((s.closes[j]! - prev) / prev) * 10_000;
    sum += r;
    sumSq += r * r;
    n += 1;
  }
  if (n < 2) return 0;
  const m = sum / n;
  const variance = sumSq / n - m * m;
  return variance > 0 ? Math.sqrt(variance) : 0;
}

/** Whether the position has hit its target, its stop or its maximum hold at this close. */
function shouldExit(state: BarsState, symbol: string, s: Series): boolean {
  const held = state.positions.get(symbol);
  if (held === undefined || held.qty === 0n) return false;
  if (s.entryIndex >= 0 && s.index - s.entryIndex >= MAX_HOLD_BARS) return true;
  const worth = state.value(symbol, held.qty);
  // Basis points of profit over what the position cost (fees included), in exact integer arithmetic.
  const pnlBps = Number(((worth - held.cost) * 10_000n) / held.cost);
  return pnlBps >= TARGET_BPS || pnlBps <= -STOP_BPS;
}

/** Whether this close is a dip worth buying: deep enough, and not into a falling 4-hour average. */
function isDip(state: BarsState, s: Series): boolean {
  const i = s.index;
  if (i < MIN_BARS) return false;
  const short = mean(s, i, SHORT_MA);
  const long = mean(s, i, LONG_MA);
  const longThen = mean(s, i - TREND_LAG, LONG_MA);
  if (short === null || long === null || longThen === null || short === 0 || longThen === 0) return false;
  const devBps = ((s.closes[i]! - short) / short) * 10_000;
  const threshold = ENTRY_FLOOR_BPS + ENTRY_SIGMAS * volatility(s, i);
  if (devBps > -threshold) return false;
  // The longer average may drift down a little, but a slide of more than TREND_DROP_BPS over the
  // lag means the market is trending, not ranging, and a dip in it is not a dip.
  return long * 10_000 >= longThen * (10_000 - TREND_DROP_BPS);
}

/** The notional to spend: SIZE_BPS of equity, bounded by cash and by the pool's depth. */
function buyNotional(state: BarsState, symbol: string, s: Series): bigint {
  const target = (state.equity * BigInt(SIZE_BPS)) / 10_000n;
  let notional = target < state.cash ? target : state.cash;
  const depth = s.depths[s.depths.length - 1] ?? 0n;
  const cap = depth / DEPTH_SHARE;
  if (notional > cap) notional = cap;
  const min = BigInt(state.hello.fees.min_notional_quote_units);
  if (notional < min) return 0n;
  return notional;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      push(state, bar);
      fresh.add(bar.symbol);
    }
    // A buy or a sell that filled on this batch's open starts or ends the position's clock.
    for (const fill of batch.fills) {
      if (fill.status !== 'filled') continue;
      const s = series.get(fill.symbol);
      if (s === undefined) continue;
      if (fill.side === 'buy') s.entryIndex = s.index;
      else {
        const held = state.positions.get(fill.symbol);
        if (held === undefined || held.qty === 0n) s.entryIndex = -1;
      }
    }

    const orders: OrderInput[] = [];
    for (const { symbol } of state.hello.symbols) {
      const s = series.get(symbol);
      // Decide only on a bar that closed this minute: a symbol absent from the batch has no news.
      if (s === undefined || !fresh.has(symbol)) continue;
      const held = state.positions.get(symbol);
      if (held !== undefined && held.qty > 0n) {
        if (shouldExit(state, symbol, s)) {
          orders.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
        continue;
      }
      const bar = state.latest.get(symbol)!;
      if (bar.o === bar.c) continue; // a flat bar means nobody traded: no entry on it
      if (!isDip(state, s)) continue;
      const notional = buyNotional(state, symbol, s);
      if (notional === 0n) continue;
      orders.push({ side: 'buy', symbol, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS });
    }
    return orders;
  },
});

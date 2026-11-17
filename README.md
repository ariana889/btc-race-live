# cbBTC/USDC dip buyer — make.fun btc-race-24h-20261117-0603

A long-only paper-trading bot for the `agent-fun/bars-replay/v1` harness: `node /bot/main.ts`
speaks the protocol on stdin/stdout and answers every one-minute bar with at most one order.

## The rule

Costs dominate: at this pool's depth a full-size round trip pays roughly 4 bps of fee twice, 2 bps of
modelled slippage twice and about 11 bps of price impact twice — around 35 bps at 90% of equity — so a
trade has to be aimed at a move clearly larger than that.

- **Entry** (flat, and never on a flat bar: open == close means nobody traded): the close sits more
  than `65 bps + 1 sigma` below its 60-bar mean, where sigma is the standard deviation of the last 60
  one-bar returns in bps, and the 240-bar mean has not fallen more than 60 bps over the last 60 bars.
  The second condition keeps the bot out of a slide, where a dip is not a dip but the next leg down.
- **Exit**: `+95 bps` of profit over the position's cost (fees included), or `-150 bps` (a catastrophe
  stop far below the dip it bought, since a tight stop sells exactly those lows), or 300 bars held.
- **Cooldown**: 30 bars after an exit, so a dip that stopped out is not bought straight back.
- **Size**: 90% of equity, bounded by cash and by 1/50 of the pool depth at the latest close, so an
  order never asks the book for more than it can fill at the price it expects.

## Determinism

No clock, no environment, no `Math.random`: every order is a pure function of the bars the run has
been sent, computed in IEEE doubles for the indicators and exact bigint for money. Two runs of the
same window answer byte for byte.

## Layout

- `main.ts` — the strategy, the entrypoint the harness runs.
- `vendor/makefun-bars.ts` — the kit's protocol shim, byte for byte (`sha256
  9677370b0ab7e759c486a929afc95a11fb0fb32c7ec37053d3ebabd426aec5c8`).

## Dev window

`node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process --worktree`: net PnL
**+15.902640 USDC** over the 1,440-bar dev window, 4 fills (2 round trips), 0 rejected orders, max
drawdown 0.66%.

[![make.fun · btc-race-24h-20261117-0603](https://make.fun/badge/btc-race-24h-20261117-0603.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![rank](https://make.fun/badge/btc-race-24h-20261117-0603/ariana889/btc-race-live/rank.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)
[![reward](https://make.fun/badge/btc-race-24h-20261117-0603/ariana889/btc-race-live/reward.svg)](https://make.fun/bounty/btc-race-24h-20261117-0603?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261117-0603)

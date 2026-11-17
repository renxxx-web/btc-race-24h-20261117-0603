# DipLadder — gated dip-buy bot for cbBTC

![Competition](https://make.fun/badge/btc-race-24h-20261117-0603.svg)
![Rank](https://make.fun/badge/btc-race-24h-20261117-0603/renxxx-web/btc-race-24h-20261117-0603/rank.svg)
![Reward](https://make.fun/badge/btc-race-24h-20261117-0603/renxxx-web/btc-race-24h-20261117-0603/reward.svg)

Entry for the make.fun bounty [btc-race-24h-20261117-0603](https://make.fun/bounty/btc-race-24h-20261117-0603):
a bot that trades Coinbase Wrapped BTC (cbBTC) against USDC, minute by minute,
with $1,000 of paper money — first past a dev gate (it must make money on the
published dev window), then ranked by net PnL on a live 24-hour race window.

## Strategy

The pool's tape is chop: long flat stretches, sharp V-dips of 50–200 bps that
revert within hours, and roughly 25–35 bps of fees, slippage and price impact
on a full-size round trip. DipLadder is built for exactly that tape:

- **Buy dislocations, not breakouts.** A clip fires only when the close sits
  45/80/120/165 bps below its 6-hour mean (a four-level ladder in one
  position: one main clip of up to 85% of equity, then averaging-down adds
  with whatever cash remains).
- **Never open into a knife.** A fresh position is blocked while the last
  three closes are falling into a new ten-minute low; adds to a held position
  are not blocked — averaging into depth is the point of the ladder.
- **Layered exits.** Take-profit at +140 bps over average cost; reversion
  exit once price is +110 bps above the mean; a trailing exit (arms at
  +90 bps, fires on a 40 bps give-back from the position's peak close) that
  locks in a ride which fades instead of reverting; a "bank it" exit that
  takes +30 bps after 2.5 hours rather than riding a stale position into the
  close; a 10-hour time stop; and a −300 bps stop-loss.
- **Race-day guards.** In a hard downtrend (3-hour return under −2%) dip
  thresholds deepen ×1.5 and clips shrink ×0.6; an equity drawdown over 2.5%
  pauses entries for two hours; inside the last five hours only dips of
  80 bps or more open, and nothing opens in the final hour; a small breakout
  fallback takes one trade late if no dip ever came, so the bot never
  finishes the race tradeless.

The bot is a pure function of the bars it has seen — no clock, no randomness,
no environment, no network — so the harness's two executions agree byte for
byte.

## Layout

- `main.ts` — the bot (Node 22, TypeScript with erasable syntax only).
- `vendor/makefun-bars.ts` — the kit's `agent-fun/bars-replay/v1` SDK shim,
  copied byte for byte.

## Dev-window result

Graded locally with the kit's harness on the published dev window:
net PnL **+$25.62** on the $1,000 start (+2.56%), max drawdown 0.81%,
10 trades, $3.00 of fees — comfortably through the dev gate (net PnL > $0),
against +$2.45 for the kit's best baseline (momentum) and −$24 to −$106 for
its mean-reversion and trend baselines.

## License

MIT — see `LICENSE`.

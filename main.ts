// DipLadder — a gated dip-buying bot for the cbBTC 24h race.
//
// Design notes (written for this race after studying the dev window and the
// public dev board):
//   * The market this pool produces is chop: many flat bars, sharp V-dips of
//     50-200 bps that revert within hours, and fee+slippage+impact of roughly
//     25-35 bps on a full-size round trip. Trend systems bleed fees here; the
//     dev board is owned by dip buyers. So this bot only buys dislocations
//     below a slow mean and sells the reversion.
//   * One position, sized in one main clip plus averaging-down adds at deeper
//     deviation levels, because a $1,000 account pays the least impact when
//     the first clip is big and the adds are whatever cash is left.
//   * Exits are layered: a hard take-profit, a reversion exit when price is
//     back above the mean, a trailing exit that locks in a big ride which
//     fades instead of reverting, a "bank it" exit that takes a modest win
//     instead of riding a stale position into the end of the window, a time
//     stop, and a deep stop-loss so a true crash day cannot sink the account.
//   * Guards for the unseen race day: no opening while price is still
//     knifing (three falling closes into a fresh low), deeper and smaller
//     entries when the 3-hour trend is down hard, an equity drawdown brake,
//     no fresh entries late in the window except on deep dips, and a small
//     breakout fallback so the bot always takes at least one trade.
//
// Everything is a pure function of the bars seen: no clock, no randomness,
// no environment. Amounts cross the wire as integers via the vendored shim.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const PRICE_SCALE = 1e5; // hello: price_scale 5
const QTY_SCALE = 1e8; // hello: qty_scale 8
const QUOTE_SCALE = 1e6; // USDC raw units per USDC

// --- strategy parameters (fractions, not bps, in code) ---
const SMA_BARS = 360; // slow mean: six hours of minutes
const MIN_HISTORY = 62; // bars before the first decision
const LEVELS = [0.0045, 0.008, 0.012, 0.0165]; // deviation below the mean that arms each clip
const CLIP_OF_EQUITY = 0.85; // each clip spends up to this share of equity (cash-capped)
const TAKE_PROFIT = 0.014; // exit all at +140 bps over average cost
const REVERSION_EXIT = 0.011; // exit all once price is +110 bps above the mean
const BANK_AFTER_MIN = 150; // after 2.5 h in a position ...
const BANK_LEVEL = 0.003; // ... bank a win of +30 bps or more
const TRAIL_ARM = 0.009; // trailing exit arms at +90 bps over average cost ...
const TRAIL_GIVEBACK = 0.004; // ... and fires when price gives back 40 bps from the position's peak close
const TIME_STOP_MIN = 600; // after 10 h ...
const TIME_STOP_LEVEL = 0.004; // ... leave if the win is under +40 bps
const STOP_LOSS = 0.03; // exit all at -300 bps under average cost
const BRAKE_DD = 0.025; // equity drawdown (share of starting capital) that pauses entries
const BRAKE_MINUTES = 120;
const TREND_GATE_R3H = -0.02; // 3 h return under -2% = hard downtrend
const TREND_GATE_MULT = 1.5; // dip thresholds deepen by this in a hard downtrend
const TREND_SIZE_MULT = 0.6; // and clips shrink to this
const LATE_DEEP_MINUTES = 300; // inside the last 5 h only deep dips open
const LATE_DEEP_LEVEL = 0.008;
const NO_ENTRY_LAST_MINUTES = 60;
const SCORED_BARS = 1440;
const FALLBACK_LAST_MINUTES = 360; // breakout fallback only in the last 6 h
const FALLBACK_NOTIONAL = 200; // USDC
const MAX_SLIPPAGE_BPS = 400;

const closes: number[] = [];
const highs: number[] = [];
let boughtLevels = new Set<number>();
let entrySeq = -1; // seq of the batch that decided the episode's first buy
let posPeak = 0; // highest close seen while the current position has been open
let brakeUntil = -1;
let peakEquity = 0;
let startCapital = 1000;
let filledTrades = 0;

function meanLast(values: number[], n: number): number {
  const m = Math.min(n, values.length);
  let s = 0;
  for (let i = values.length - m; i < values.length; i++) s += values[i]!;
  return s / m;
}

await runBars({
  onHello(state: BarsState) {
    startCapital = Number(state.hello.capital.quote_units) / QUOTE_SCALE;
    peakEquity = startCapital;
  },

  onBatch(state: BarsState, batch: Batch) {
    // Count our own filled orders (the harness's flatten fills carry a
    // client_id starting with "_flatten" and do not count as our trades).
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) filledTrades++;
    }

    const bar = state.latest.get(SYMBOL);
    if (bar === undefined) return [];
    const close = Number(bar.c) / PRICE_SCALE;
    closes.push(close);
    highs.push(Number(bar.h) / PRICE_SCALE);

    const equity = Number(state.equity) / QUOTE_SCALE;
    const cash = Number(state.cash) / QUOTE_SCALE;
    if (equity > peakEquity) peakEquity = equity;
    const drawdown = (peakEquity - equity) / startCapital;

    const pos = state.positions.get(SYMBOL);
    const qtyRaw = pos?.qty ?? 0n;
    const qtyBtc = Number(qtyRaw) / QTY_SCALE;
    const avgCost = pos !== undefined && qtyBtc > 0 ? Number(pos.cost) / QUOTE_SCALE / qtyBtc : 0;
    const unreal = qtyBtc > 0 ? close / avgCost - 1 : 0;

    // A flat book closes the episode: re-arm every ladder level.
    if (qtyBtc === 0 && entrySeq >= 0) {
      boughtLevels = new Set<number>();
      entrySeq = -1;
    }
    if (qtyBtc === 0) posPeak = 0;
    else if (close > posPeak) posPeak = close;

    if (state.warmingUp) return [];
    if (closes.length < MIN_HISTORY) return [];

    const sma = meanLast(closes, SMA_BARS);
    const dev = close / sma - 1;
    const heldMin = entrySeq >= 0 ? state.seq - entrySeq : 0;
    const scoredIdx = state.seq - state.warmupBars;
    const barsLeft = SCORED_BARS - scoredIdx;

    const orders: OrderInput[] = [];

    // ---- exits (one sell-all at most; a sell and a buy never share a reply)
    if (qtyBtc > 0) {
      const exitAll =
        unreal >= TAKE_PROFIT ||
        dev >= REVERSION_EXIT ||
        unreal <= -STOP_LOSS ||
        (unreal >= TRAIL_ARM && posPeak > 0 && close <= posPeak * (1 - TRAIL_GIVEBACK)) ||
        (heldMin >= BANK_AFTER_MIN && unreal >= BANK_LEVEL) ||
        (heldMin >= TIME_STOP_MIN && unreal < TIME_STOP_LEVEL);
      if (exitAll) {
        orders.push({ side: 'sell', symbol: SYMBOL, qty: qtyRaw, max_slippage_bps: MAX_SLIPPAGE_BPS });
        return orders;
      }
    }

    // ---- entries
    if (drawdown > BRAKE_DD) brakeUntil = Math.max(brakeUntil, state.seq + BRAKE_MINUTES);
    if (state.seq < brakeUntil) return orders;
    if (barsLeft <= NO_ENTRY_LAST_MINUTES) return orders;

    let gate = 1;
    let sizeMult = 1;
    if (closes.length >= 180) {
      const r3h = closes[closes.length - 1]! / closes[closes.length - 180]! - 1;
      if (r3h < TREND_GATE_R3H) {
        gate = TREND_GATE_MULT;
        sizeMult = TREND_SIZE_MULT;
      }
    }

    // Opening gate: never open into a knife — three falling closes and the
    // lowest close of the last ten minutes. Adds to a held position are not
    // gated: averaging into depth is the point of the ladder.
    let openingBlocked = false;
    if (qtyBtc === 0 && closes.length >= 11) {
      const n = closes.length;
      const falling = closes[n - 1]! < closes[n - 2]! && closes[n - 2]! < closes[n - 3]!;
      let prevLow = Infinity;
      for (let i = n - 11; i < n - 1; i++) prevLow = Math.min(prevLow, closes[i]!);
      openingBlocked = falling && close <= prevLow * 1.0002;
    }

    if (!openingBlocked) {
      const minFirst = barsLeft < LATE_DEEP_MINUTES ? LATE_DEEP_LEVEL : LEVELS[0]!;
      for (let i = 0; i < LEVELS.length; i++) {
        const lvl = i === 0 ? Math.max(LEVELS[0]!, minFirst) : LEVELS[i]!;
        if (dev <= -lvl * gate && !boughtLevels.has(i)) {
          const notional = Math.min(cash, CLIP_OF_EQUITY * equity * sizeMult);
          if (notional >= 5) {
            orders.push({
              side: 'buy',
              symbol: SYMBOL,
              notional_quote_units: BigInt(Math.floor(notional * QUOTE_SCALE)),
              max_slippage_bps: MAX_SLIPPAGE_BPS,
            });
            boughtLevels.add(i);
            if (entrySeq < 0) entrySeq = state.seq;
          }
          break; // one clip per bar
        }
      }
    }

    // Breakout fallback: if the whole day passed without a single dip trade,
    // take one small momentum position late rather than finish tradeless
    // (an entry with no trade on the race window ranks below every trader).
    if (orders.length === 0 && qtyBtc === 0 && filledTrades === 0 && barsLeft < FALLBACK_LAST_MINUTES && closes.length >= 120) {
      let hi = 0;
      for (let i = highs.length - 120; i < highs.length; i++) hi = Math.max(hi, highs[i]!);
      if (close >= hi * (1 - 0.0005)) {
        const notional = Math.min(cash, FALLBACK_NOTIONAL);
        if (notional >= 5) {
          orders.push({
            side: 'buy',
            symbol: SYMBOL,
            notional_quote_units: BigInt(Math.floor(notional * QUOTE_SCALE)),
            max_slippage_bps: MAX_SLIPPAGE_BPS,
          });
          if (entrySeq < 0) entrySeq = state.seq;
        }
      }
    }

    return orders;
  },
});

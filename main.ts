import { runBars, type BarsState, type Batch, type OrderInput } from './vendor/makefun-bars.ts';

export const SYMBOL = 'CBBTC';
export const WASHOUT_WINDOW = 120;
export const WASHOUT_DEPTH = 0.03;
export const BOUNCE_CONFIRM = 0.0025;
export const TAKE_PROFIT = 0.04;
export const STOP_LOSS = 0.05;
export const MAX_HOLD = 720;
export const MAX_SLIPPAGE_BPS = 100;
export const FALLBACK_SEQ = 1200;

// Module-scope strategy state: purely a function of the batches the shim hands us.
let closes: bigint[] = [];
let holdBars = 0;
let everBought = false;

/** A fractional constant as integer basis points (10000 bps = 100%), for bigint comparisons. */
const bps = (f: number) => BigInt(Math.round(f * 10_000));

/** Deep-washout-then-bounce entry, checked against the 180 closes ending at the previous bar. */
function washoutAndBounceEntered(): boolean {
  if (closes.length <= WASHOUT_WINDOW) return false;
  const latest = closes[closes.length - 1]!;
  const prev = closes[closes.length - 2]!;
  let high = 0n;
  for (let i = closes.length - 2; i >= closes.length - 1 - WASHOUT_WINDOW; i--) {
    const c = closes[i]!;
    if (c > high) high = c;
  }
  // latest at most 3% below the window high: latest <= high * (1 - 0.03)
  const withinDepth = latest * 10_000n <= high * (10_000n - bps(WASHOUT_DEPTH));
  // more than 0.08% above the previous close: latest > prev * (1 + 0.0008)
  const bounced = latest * 10_000n > prev * (10_000n + bps(BOUNCE_CONFIRM));
  return withinDepth && bounced;
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  for (const bar of batch.bars) {
    if (bar.symbol === SYMBOL) closes.push(BigInt(bar.c));
  }

  for (const fill of batch.fills) {
    if (fill.symbol === SYMBOL && fill.side === 'buy' && fill.status === 'filled') everBought = true;
  }

  const held = state.positions.get(SYMBOL);

  if (held !== undefined && held.qty > 0n) {
    holdBars++;
    const value = state.value(SYMBOL, held.qty);
    const cost = held.cost;
    const takeProfit = value * 10_000n >= cost * (10_000n + bps(TAKE_PROFIT));
    const stopLossHit = value * 10_000n <= cost * (10_000n - bps(STOP_LOSS));
    const timedOut = holdBars >= MAX_HOLD;
    if (takeProfit || stopLossHit || timedOut) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  }

  holdBars = 0;
  const canTrade = !state.warmingUp;
  const fallback = !everBought && batch.seq >= FALLBACK_SEQ;
  if (canTrade && (washoutAndBounceEntered() || fallback)) {
    if (state.cash > 0n) {
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
  }
  return [];
}

await runBars({ onBatch });

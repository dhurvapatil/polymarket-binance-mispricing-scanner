// test-binance.js
// Manual live-API probe (not a Jest test; hits Binance). Run: node scripts/test-binance.js
// Tests both futures price fetch and the new options data fetch

import axios from 'axios';

// ─── Minimal logger stub (no need for your real logger) ──────────────────────
const Logger = {
  info: (tag, msg) => console.log(`[INFO]  [${tag}] ${msg}`),
  debug: (tag, msg) => console.log(`[DEBUG] [${tag}] ${msg}`),
  warn: (tag, msg) => console.warn(`[WARN]  [${tag}] ${msg}`),
  error: (tag, msg) => console.error(`[ERROR] [${tag}] ${msg}`),
};

// ─── Paste / import your BinanceService here ─────────────────────────────────
// Option A: if running from src/services/, just do:
//   import { BinanceService } from './binance.js';
//
// Option B: quick inline version for isolated testing — copy the class body here.
// For now we test the raw API calls directly so you can verify the data shape.

const FUTURES_BASE = 'https://fapi.binance.com/fapi/v1';
const OPTIONS_BASE = 'https://eapi.binance.com/eapi/v1';

// ─── Test 1: Futures price ────────────────────────────────────────────────────
async function testFuturesPrice(symbol = 'BTCUSDT') {
  console.log('\n━━━ TEST 1: Futures price ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const res = await axios.get(`${FUTURES_BASE}/ticker/price`, {
      params: { symbol },
      timeout: 10000,
    });
    console.log('✅ Status:', res.status);
    console.log('   Symbol:', res.data.symbol);
    console.log('   Price: $', parseFloat(res.data.price).toLocaleString());
    return res.data;
  } catch (err) {
    console.error('❌ Failed:', err.message);
    if (err.response) console.error('   Response:', err.response.data);
  }
}

// ─── Test 2: Raw options mark prices ─────────────────────────────────────────
async function testOptionsMarkPrice(underlying = 'BTCUSDT') {
  console.log('\n━━━ TEST 2: Options mark prices ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  try {
    const res = await axios.get(`${OPTIONS_BASE}/mark`, {
      params: { underlying },
      timeout: 10000,
    });
    console.log('✅ Status:', res.status);
    console.log('   Total contracts returned:', res.data.length);

    // Show the first 3 contracts so you can inspect the shape
    const sample = res.data.slice(0, 3);
    console.log('\n   Sample contracts:');
    sample.forEach((c, i) => {
      console.log(`\n   [${i}] symbol:            ${c.symbol}`);
      console.log(`       markPrice:          ${c.markPrice}`);
      console.log(`       markIV (ann.):      ${c.markIV}`);         // this is what Black-Scholes needs
      console.log(`       bidIV:              ${c.bidIV}`);
      console.log(`       askIV:              ${c.askIV}`);
      console.log(`       delta:              ${c.delta}`);
      console.log(`       indexPrice:         ${c.indexPrice}`);     // underlying spot price
    });

    return res.data;
  } catch (err) {
    console.error('❌ Failed:', err.message);
    if (err.response) console.error('   Response:', JSON.stringify(err.response.data, null, 2));
  }
}

// ─── Test 3: Match logic — simulate what arbitrage.js will do ─────────────────
// Given a fake Polymarket question "Will BTC reach $120,000 by end of June?"
// find the best matching call option.
async function testMatchLogic(contracts) {
  if (!contracts || contracts.length === 0) {
    console.log('\n⚠️  Skipping match test — no contracts from Test 2');
    return;
  }

  console.log('\n━━━ TEST 3: Match logic ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  // Simulated Polymarket question parameters
  const targetStrike = 120000;
  const targetExpiry = new Date('2025-06-27'); // adjust to a real near-future date
  console.log(`   Looking for: BTC call | strike ~$${targetStrike.toLocaleString()} | expiry ~${targetExpiry.toDateString()}`);

  // Filter calls only
  const calls = contracts.filter(c => c.symbol?.endsWith('-C'));
  console.log(`   Call contracts available: ${calls.length}`);

  // Parse symbol helper
  function parseSymbol(symbol) {
    const parts = symbol.split('-');
    if (parts.length !== 4) return null;
    const [underlying, dateStr, strikeStr, type] = parts;
    const year = 2000 + parseInt(dateStr.slice(0, 2));
    const month = parseInt(dateStr.slice(2, 4)) - 1;
    const day = parseInt(dateStr.slice(4, 6));
    return {
      underlying,
      expiry: new Date(year, month, day, 8, 0, 0),
      strike: parseFloat(strikeStr),
      type,
    };
  }

  // Score and find best match
  const now = Date.now();
  const targetMs = targetExpiry.getTime();
  let best = null, bestScore = Infinity;

  for (const c of calls) {
    const p = parseSymbol(c.symbol);
    if (!p) continue;
    if (p.expiry.getTime() < now) continue;       // already expired
    if (p.expiry.getTime() < targetMs) continue;  // expires before question resolves

    const strikeDiff = Math.abs(p.strike - targetStrike) / targetStrike;
    const expiryDiff = (p.expiry.getTime() - targetMs) / (1000 * 60 * 60 * 24);
    const score = strikeDiff * 3 + expiryDiff * 0.01;

    if (score < bestScore) { bestScore = score; best = c; }
  }

  if (best) {
    const p = parseSymbol(best.symbol);
    console.log('\n   ✅ Best match found:');
    console.log(`      Symbol:  ${best.symbol}`);
    console.log(`      Strike:  $${p.strike.toLocaleString()}`);
    console.log(`      Expiry:  ${p.expiry.toDateString()}`);
    console.log(`      IV:      ${(parseFloat(best.markIV) * 100).toFixed(1)}%`);
    console.log(`      Score:   ${bestScore.toFixed(4)}`);
    console.log('\n   ✅ This IV value is what gets passed to Black-Scholes next.');
  } else {
    console.log('\n   ⚠️  No matching contract found.');
    console.log('      This means: arbitrage.js will skip this market (correct behaviour).');
    console.log('      Try adjusting targetStrike or targetExpiry to a listed contract.');

    // Show what IS available so you can adjust
    const available = calls.slice(0, 5).map(c => {
      const p = parseSymbol(c.symbol);
      return p ? `${c.symbol} (strike $${p.strike.toLocaleString()}, expiry ${p.expiry.toDateString()})` : c.symbol;
    });
    console.log('\n   Available call contracts (first 5):');
    available.forEach(s => console.log('     -', s));
  }
}

// ─── Run all tests ────────────────────────────────────────────────────────────
(async () => {
  await testFuturesPrice('BTCUSDT');
  const contracts = await testOptionsMarkPrice('BTCUSDT');
  await testMatchLogic(contracts);

  console.log('\n━━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
})();


// test-blackscholes.js
// Manual sanity script (not a Jest test). Run: node scripts/test-blackscholes.js
// Uses the EXACT values from your test-binance.js output to verify the math.

import { impliedProbability, blackScholesDetail, daysToYears } from '../src/services/blackscholes.js';

// Values from your Test 3 output
const S = 67457.5;   // BTC spot price
const K = 120000;    // Strike from matched contract
const sigma = 0.744; // markIV from Test 3 (74.4%)
const r = 0.05;      // Risk-free rate (5%)
const T = daysToYears(new Date('2026-04-24')); // Expiry from matched contract

console.log('━━━ Inputs ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`  Underlying price (S):   $${S.toLocaleString()}`);
console.log(`  Strike price (K):       $${K.toLocaleString()}`);
console.log(`  Implied volatility:     ${(sigma * 100).toFixed(1)}%`);
console.log(`  Risk-free rate:         ${(r * 100).toFixed(1)}%`);
console.log(`  Time to expiry (T):     ${(T * 365).toFixed(0)} days (${T.toFixed(4)} years)`);

// Test 1: impliedProbability()
console.log('\n━━━ TEST 1: impliedProbability() ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const prob = impliedProbability(S, K, T, r, sigma);

if (prob === null) {
  console.error('❌ Returned null — check inputs');
} else {
  console.log(`  N(d2) probability:      ${(prob * 100).toFixed(2)}%`);
  console.log(`\n  ✅ This is what arbitrage.js will compare against Polymarket.`);
  console.log(`     If Polymarket shows BTC reaching $120k at e.g. 8%,`);
  console.log(`     and Black-Scholes gives ${(prob * 100).toFixed(1)}%, delta = ${((0.08 - prob) * 100).toFixed(1)}pp`);
}

// Test 2: blackScholesDetail()
console.log('\n━━━ TEST 2: Full detail ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
const detail = blackScholesDetail(S, K, T, r, sigma);

if (!detail) {
  console.error('❌ Returned null');
} else {
  console.log(`  d1:                     ${detail.d1.toFixed(4)}`);
  console.log(`  d2:                     ${detail.d2.toFixed(4)}`);
  console.log(`  N(d2) probability:      ${(detail.probability * 100).toFixed(2)}%`);
  console.log(`  Theoretical call price: $${detail.callPrice.toFixed(2)}`);
  console.log(`  Delta (N(d1)):          ${detail.delta.toFixed(4)}`);
  console.log(`  Intrinsic value:        $${detail.intrinsicValue.toFixed(2)}`);
  console.log(`\n  Sanity check — Binance markPrice for this contract: $45.34`);
  console.log(`  Our theoretical call:   $${detail.callPrice.toFixed(2)}`);
  console.log(`  ${Math.abs(detail.callPrice - 45.34) < 20 ? '✅ Close enough — model is working' : '⚠️  Large gap — check inputs'}`);
}

// Test 3: Edge cases
console.log('\n━━━ TEST 3: Edge cases ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

const cases = [
  { label: 'Strike = spot (ATM)',      S: 67457, K: 67457,  T: 0.25,   sigma: 0.60 },
  { label: 'Deep ITM (S >> K)',        S: 67457, K: 30000,  T: 0.25,   sigma: 0.60 },
  { label: 'Deep OTM (S << K)',        S: 67457, K: 200000, T: 0.25,   sigma: 0.60 },
  { label: 'Very short expiry (1 day)',S: 67457, K: 120000, T: 1 / 365, sigma: 0.60 },
  { label: 'Bad input — zero IV',      S: 67457, K: 120000, T: 0.5,    sigma: 0 },
  { label: 'Bad input — null',         S: null,  K: 120000, T: 0.5,    sigma: 0.6 },
];

for (const c of cases) {
  const p = impliedProbability(c.S, c.K, c.T, 0.05, c.sigma);
  const pStr = p === null ? 'null (skipped safely)' : `${(p * 100).toFixed(2)}%`;
  console.log(`  ${c.label.padEnd(30)} → ${pStr}`);
}

console.log('\n━━━ Done ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
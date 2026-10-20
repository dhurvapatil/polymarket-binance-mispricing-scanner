// blackScholes.js
// Converts implied volatility from Binance options into a real market-implied
// probability that BTC/ETH/etc. will be above a given strike at expiry.
//
// The key output is N(d2) — the risk-neutral probability of finishing
// in-the-money. This is what gets compared against Polymarket's implied prob.

// ─── Cumulative standard normal distribution ──────────────────────────────────
// Phi(x) = 0.5 * (1 + erf(x / sqrt 2)), with erf from Abramowitz & Stegun 7.1.26
// (max abs error ~1.5e-7).
// No external library needed.
function cdf(x) {
    if (x < -8) return 0;
    if (x > 8) return 1;

    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    const absX = Math.abs(x);

    const z = absX / Math.SQRT2; // erf argument
    const t = 1 / (1 + p * z);
    const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-z * z);

    return 0.5 * (1 + sign * y);
}

// ─── Core Black-Scholes ───────────────────────────────────────────────────────

/**
 * Calculate d1 and d2 — the two intermediate values in Black-Scholes.
 *
 * @param {number} S     - Current underlying price (e.g. 67457)
 * @param {number} K     - Strike price (e.g. 120000)
 * @param {number} T     - Time to expiry in YEARS (e.g. 0.5 for 6 months)
 * @param {number} r     - Risk-free rate (annualised, e.g. 0.05 for 5%)
 * @param {number} sigma - Implied volatility (annualised, e.g. 0.744 for 74.4%)
 * @returns {{ d1: number, d2: number }}
 */
function calcD1D2(S, K, T, r, sigma) {
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * Math.sqrt(T));
    const d2 = d1 - sigma * Math.sqrt(T);
    return { d1, d2 };
}

/**
 * Risk-neutral probability that the underlying finishes ABOVE the strike.
 * This is N(d2) for a call — exactly what Polymarket's "Yes" price represents.
 *
 * @param {number} S     - Current underlying price
 * @param {number} K     - Strike price (price target from Polymarket question)
 * @param {number} T     - Time to expiry in years
 * @param {number} r     - Risk-free rate (default 0.05)
 * @param {number} sigma - Implied volatility from Binance options (annualised)
 * @returns {number}     - Probability between 0 and 1
 */
export function impliedProbability(S, K, T, r = 0.05, sigma) {
    // Input validation — return null so arbitrage.js can skip gracefully
    if (!S || !K || !T || !sigma) {
        return null;
    }
    if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) {
        return null;
    }
    if (sigma > 5) {
        // IV above 500% is almost certainly a data error from the API
        return null;
    }

    const { d2 } = calcD1D2(S, K, T, r, sigma);

    // N(d2) = probability of S > K at expiry under risk-neutral measure
    return cdf(d2);
}

/**
 * Full Black-Scholes output — useful for debugging and logging.
 *
 * @returns {{
 *   probability: number,   // N(d2) — the number arbitrage.js uses
 *   d1: number,
 *   d2: number,
 *   callPrice: number,     // theoretical call option price
 *   delta: number,         // N(d1) — hedge ratio
 *   intrinsicValue: number // max(S - K, 0)
 * } | null}
 */
export function blackScholesDetail(S, K, T, r = 0.05, sigma) {
    if (!S || !K || !T || !sigma) return null;
    if (S <= 0 || K <= 0 || T <= 0 || sigma <= 0) return null;

    const { d1, d2 } = calcD1D2(S, K, T, r, sigma);

    const Nd1 = cdf(d1);
    const Nd2 = cdf(d2);

    // Black-Scholes call price
    const callPrice = S * Nd1 - K * Math.exp(-r * T) * Nd2;

    return {
        probability: Nd2,          // THIS is what gets compared to Polymarket
        d1,
        d2,
        callPrice,
        delta: Nd1,
        intrinsicValue: Math.max(S - K, 0),
    };
}

/**
 * Convert a JS Date (Polymarket expiry) into years-to-expiry (T).
 * Black-Scholes needs T in years, not days or ms.
 *
 * @param {Date} expiryDate
 * @returns {number} T in years, minimum 1/365 (one day)
 */
export function daysToYears(expiryDate) {
    const msPerYear = 365.25 * 24 * 60 * 60 * 1000;
    const T = (expiryDate.getTime() - Date.now()) / msPerYear;
    return Math.max(T, 1 / 365); // floor at 1 day to avoid divide-by-zero
}


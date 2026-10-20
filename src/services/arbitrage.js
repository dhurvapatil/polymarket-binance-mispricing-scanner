// Arbitrage Calculator
// Matches Polymarket binary markets with Binance futures/options and calculates
// real arbitrage opportunities using Black-Scholes implied probability.

import { Logger } from '../utils/logger.js';
import { impliedProbability, daysToYears } from './blackscholes.js';

// Risk-free rate assumption (annualised) — US 3-month T-bill approximation
const RISK_FREE_RATE = 0.05;

export class ArbitrageService {
  constructor(polymarketService, binanceService, telegramService = null, options = {}) {
    this.polymarketService = polymarketService;
    this.binanceService = binanceService;
    this.telegramService = telegramService;

    // Fee constants (as decimals)
    this.fees = {
      polymarket: 0.025,  // 2.5% total Polymarket fees
      binance: 0.0004,    // 0.04% Binance futures fees (round trip)
      slippage: 0.001     // 0.1% slippage buffer
    };

    // Minimum net edge as a fraction of notional (0.005 = 0.5%)
    this.minProfitThreshold = options.minProfitThreshold ?? 0.005;
  }

  // ─── Public: main entry points ───────────────────────────────────────────────

  /**
   * Match Polymarket binary markets with Binance futures prices.
   * For each matched market, attempts to derive a real Black-Scholes probability
   * using Binance Options IV. Markets without extractable strike prices are skipped.
   *
   * @param {Array} polymarketMarkets
   * @param {Array} binancePrices
   * @returns {Array} Array of arbitrage opportunity objects
   */
  async matchMarkets(polymarketMarkets, binancePrices) {
    Logger.info('ARBITRAGE', `Matching ${polymarketMarkets.length} Polymarket markets with ${binancePrices.length} Binance prices`);

    const opportunities = [];

    // Build a fast symbol → price lookup
    const priceMap = new Map();
    binancePrices.forEach(p => priceMap.set(p.symbol, p));

    for (const market of polymarketMarkets) {
      try {
        if (!this.isBinaryMarket(market)) continue;

        const symbol = this.extractCryptoSymbol(market);
        if (!symbol) {
          Logger.debug('ARBITRAGE', `No crypto symbol found: "${market.question}"`);
          continue;
        }

        const binanceSymbol = `${symbol}USDT`;
        const futuresPrice = priceMap.get(binanceSymbol);
        if (!futuresPrice) {
          Logger.debug('ARBITRAGE', `No Binance price for ${binanceSymbol}`);
          continue;
        }

        const opportunity = await this.calculateArbitrage(market, futuresPrice, symbol);
        if (opportunity) opportunities.push(opportunity);

      } catch (error) {
        Logger.warn('ARBITRAGE', `Error processing market ${market.id}: ${error.message}`);
      }
    }

    Logger.info('ARBITRAGE', `Found ${opportunities.length} potential arbitrage opportunities`);
    return opportunities;
  }

  /**
   * Filter opportunities by minimum profit threshold and dispatch Telegram alerts.
   * @param {Array} opportunities
   * @param {number} minThreshold
   * @returns {Array} Filtered and sorted opportunities
   */
  async filterOpportunities(opportunities, minThreshold = this.minProfitThreshold) {
    Logger.info('ARBITRAGE', `Filtering ${opportunities.length} opportunities (min ${minThreshold * 100}%)`);

    const filtered = opportunities
      .filter(opp => opp.arbitrage.profitMargin >= minThreshold)
      .sort((a, b) => b.arbitrage.profitMargin - a.arbitrage.profitMargin);

    Logger.info('ARBITRAGE', `${filtered.length} opportunities meet threshold`);

    if (this.telegramService && filtered.length > 0) {
      for (const opp of filtered) {
        try {
          await this.telegramService.sendArbitrageAlert(opp);
        } catch (error) {
          Logger.error('ARBITRAGE', `Telegram alert failed: ${error.message}`);
        }
      }
    } else if (!this.telegramService && filtered.length > 0) {
      Logger.warn('ARBITRAGE', `${filtered.length} opportunities found but no Telegram service configured`);
    }

    return filtered;
  }

  /**
   * Summary statistics over an array of opportunities.
   */
  getStatistics(opportunities) {
    if (opportunities.length === 0) {
      return { total: 0, averageProfit: 0, highConfidence: 0, maxProfit: 0 };
    }
    const profits = opportunities.map(o => o.arbitrage.profitMargin);
    return {
      total: opportunities.length,
      averageProfit: profits.reduce((s, p) => s + p, 0) / profits.length,
      highConfidence: opportunities.filter(o => o.confidence === 'high').length,
      maxProfit: Math.max(...profits)
    };
  }

  // ─── Core arbitrage calculation ───────────────────────────────────────────────

  /**
   * Full arbitrage calculation for a single market.
   *
   * Flow:
   *   1. Read Polymarket implied probability (Yes price)
   *   2. Extract price target (K) from the question text
   *   3. Fetch Binance Options IV for that strike/expiry → Black-Scholes prob
   *   4. Compare the two probabilities, compute net profit after fees
   *
   * @param {Object} market        - Polymarket market object (with .probability)
   * @param {Object} futuresPrice  - { symbol, price, timestamp }
   * @param {string} underlying    - e.g. 'BTC', 'ETH'
   * @returns {Object|null}
   */
  async calculateArbitrage(market, futuresPrice, underlying) {
    try {
      // ── Step 1: Polymarket implied probability ─────────────────────────────
      const polymarketProb = market.probability;
      if (polymarketProb === null || polymarketProb === undefined) return null;

      // ── Step 2: Extract price target from question ─────────────────────────
      const strikePrice = this.extractStrikePrice(market.question);
      if (!strikePrice) {
        Logger.debug('ARBITRAGE', `No strike price in question: "${market.question}"`);
        return null;
      }

      const direction = this.determineMarketDirection(market);
      if (!direction) {
        Logger.debug('ARBITRAGE', `Cannot determine direction: "${market.question}"`);
        return null;
      }

      const currentPrice = futuresPrice.price;
      const expiry = market.expiresAt ? new Date(market.expiresAt) : null;
      if (!expiry || isNaN(expiry.getTime())) {
        Logger.debug('ARBITRAGE', `No valid expiry, cannot price: "${market.question}"`);
        return null;
      }

      // ── Step 3: Black-Scholes probability via Binance Options IV ───────────
      let bsProb = null;
      let optionsData = null;

      try {
        optionsData = await this.binanceService.fetchOptionsData(underlying, expiry, strikePrice);
      } catch (err) {
        Logger.debug('ARBITRAGE', `Options fetch skipped for ${underlying}: ${err.message}`);
      }

      if (optionsData && optionsData.impliedVolatility) {
        const T = daysToYears(expiry);
        const sigma = optionsData.impliedVolatility;
        const S = currentPrice;
        const K = strikePrice;

        const pAbove = impliedProbability(S, K, T, RISK_FREE_RATE, sigma); // P(S > K) at expiry
        bsProb = pAbove === null ? null : (direction === 'bullish' ? pAbove : 1 - pAbove);

        if (bsProb !== null) {
          Logger.info('ARBITRAGE',
            `BS prob for ${underlying} strike=$${strikePrice} IV=${(sigma * 100).toFixed(1)}%: ` +
            `${(bsProb * 100).toFixed(2)}% (Polymarket: ${(polymarketProb * 100).toFixed(2)}%)`
          );
        }
      }

      // ── Fallback: skip this market — we don't guess anymore ───────────────
      if (bsProb === null) {
        Logger.debug('ARBITRAGE',
          `Skipping "${market.question}" — no Black-Scholes probability available`);
        return null;
      }

      // ── Step 4: Probability delta and profit model ─────────────────────────
      const { probDelta, positionSize, grossProfit, totalFees, netProfit, profitMargin } =
        this.computeEdge(polymarketProb, bsProb);

      if (Math.abs(probDelta) < 0.001) return null; // < 0.1% difference, not worth it

      if (profitMargin < this.minProfitThreshold) return null;

      // ── Build opportunity object ───────────────────────────────────────────
      const opportunity = {
        market: {
          id: market.id,
          question: market.question,
          probability: polymarketProb,
          direction,
          expiresAt: market.expiresAt
        },
        futures: {
          symbol: futuresPrice.symbol,
          price: currentPrice,
          timestamp: futuresPrice.timestamp
        },
        options: optionsData ? {
          symbol: optionsData.symbol,
          strike: optionsData.strike,
          expiry: optionsData.expiry,
          impliedVolatility: optionsData.impliedVolatility,
          markPrice: optionsData.markPrice
        } : null,
        arbitrage: {
          polymarketProb,
          bsProb,
          probabilityDelta: probDelta,
          grossProfit,
          totalFees,
          netProfit,
          profitMargin,
          positionSize
        },
        // Positive delta → Polymarket overprices Yes → sell Yes on Polymarket, buy on Binance
        // Negative delta → Polymarket underprices Yes → buy Yes on Polymarket, hedge short on Binance
        recommendation: probDelta > 0 ? 'SELL_POLYMARKET_YES' : 'BUY_POLYMARKET_YES',
        confidence: this.calculateConfidence(probDelta, optionsData),
        timestamp: Date.now()
      };

      Logger.debug('ARBITRAGE',
        `Opportunity: "${market.question.substring(0, 60)}" | ` +
        `Δ=${(probDelta * 100).toFixed(2)}pp | net=${(profitMargin * 100).toFixed(2)}%`
      );

      return opportunity;

    } catch (error) {
      Logger.warn('ARBITRAGE', `calculateArbitrage error for ${market.id}: ${error.message}`);
      return null;
    }
  }

  // ─── Helper methods ───────────────────────────────────────────────────────────

  /**
   * Gross/net edge for a Polymarket-vs-model probability gap.
   * net = |p_poly - p_model| * size - size * (polymarket + binance + slippage fees)
   */
  computeEdge(polymarketProb, bsProb, positionSize = 1000) {
    const probDelta = polymarketProb - bsProb;
    const grossProfit = Math.abs(probDelta) * positionSize;
    const totalFees = positionSize * (this.fees.polymarket + this.fees.binance + this.fees.slippage);
    const netProfit = grossProfit - totalFees;
    return { probDelta, positionSize, grossProfit, totalFees, netProfit, profitMargin: netProfit / positionSize };
  }

  /**
   * Check if a market is a binary Yes/No market.
   */
  isBinaryMarket(market) {
    return market.outcomes &&
           Array.isArray(market.outcomes) &&
           market.outcomes.length === 2 &&
           market.outcomes.includes('Yes') &&
           market.outcomes.includes('No');
  }

  /**
   * Extract the primary cryptocurrency symbol from a Polymarket question.
   * Returns the canonical ticker (BTC, ETH, SOL, etc.) or null.
   */
  extractCryptoSymbol(market) {
    const text = (market.question || '').toLowerCase();

    const patterns = [
      [/\b(btc|bitcoin)\b/i, 'BTC'],
      [/\b(eth|ethereum)\b/i, 'ETH'],
      [/\b(sol|solana)\b/i, 'SOL'],
      [/\b(ada|cardano)\b/i, 'ADA'],
      [/\b(dot|polkadot)\b/i, 'DOT'],
      [/\b(link|chainlink)\b/i, 'LINK'],
      [/\b(uni|uniswap)\b/i, 'UNI'],
      [/\b(aave)\b/i, 'AAVE'],
      [/\b(comp|compound)\b/i, 'COMP'],
      [/\b(mkr|maker)\b/i, 'MKR'],
    ];

    for (const [pattern, ticker] of patterns) {
      if (pattern.test(text)) return ticker;
    }
    return null;
  }

  /**
   * Extract a dollar price target from a Polymarket question.
   * e.g. "Will BTC reach $120,000 by April?" → 120000
   * Returns null if no clear price target is found.
   */
  extractStrikePrice(question) {
    if (!question) return null;

    // Match patterns like $120k, $120,000, $120000, $1.2m, $1.2M
    const patterns = [
      /\$(\d[\d,]*\.?\d*)\s*[Mm]\b/,   // $1.2m or $120M (word boundary: "$120,000 mid-June" is not millions)
      /\$(\d[\d,]*\.?\d*)\s*[Kk]\b/,   // $120k or $120K
      /\$(\d[\d,]*\.?\d*)/,            // $120,000 or $120000 or $2,500.50
    ];

    for (const pattern of patterns) {
      const match = question.match(pattern);
      if (match) {
        let value = parseFloat(match[1].replace(/,/g, ''));
        // Apply multiplier suffix
        if (/[Mm]/.test(match[0])) value *= 1_000_000;
        if (/[Kk]/.test(match[0])) value *= 1_000;
        if (value > 0) return value;
      }
    }

    return null;
  }

  /**
   * Determine market direction from keyword analysis.
   * Returns 'bullish' (P(above K)), 'bearish' (P(below K)), or null.
   */
  determineMarketDirection(market) {
    const q = (market.question || '').toLowerCase();

    const bullish = ['reach', 'above', 'over', 'higher than', 'surpass', 'exceed', 'break above', 'hit'];
    const bearish  = ['below', 'under', 'lower than', 'drop below', 'fall below', 'drop to'];

    const isBullish = bullish.some(kw => q.includes(kw));
    const isBearish = bearish.some(kw => q.includes(kw));

    if (isBullish && !isBearish) return 'bullish';
    if (isBearish && !isBullish) return 'bearish';
    return null; // ambiguous — skip rather than guess
  }

  /**
   * Confidence score based on probability delta magnitude and whether
   * real options data backed the calculation.
   */
  calculateConfidence(probDelta, optionsData) {
    const delta = Math.abs(probDelta);
    // Downgrade confidence if no real options data was available
    const hasRealData = !!optionsData;

    if (!hasRealData) return 'low';
    if (delta > 0.05) return 'high';    // > 5pp difference
    if (delta > 0.02) return 'medium';  // > 2pp difference
    return 'low';
  }
}
// Binance Futures API Client
// Fetches futures contract prices and funding rates using public endpoints

import axios from 'axios';
import { Logger } from '../utils/logger.js';

// ─── Binance European options helpers (pure, exported for testing) ────────────

/**
 * Parse a Binance options symbol such as "BTC-260424-120000-C".
 * Expiry is 08:00 UTC on the encoded date. Returns null if malformed.
 */
export function parseOptionSymbol(symbol) {
  if (typeof symbol !== 'string') return null;
  const parts = symbol.split('-');
  if (parts.length !== 4) return null;
  const [underlying, dateStr, strikeStr, type] = parts;
  if (!/^\d{6}$/.test(dateStr) || (type !== 'C' && type !== 'P')) return null;
  const strike = parseFloat(strikeStr);
  if (!Number.isFinite(strike) || strike <= 0) return null;
  const expiry = new Date(Date.UTC(
    2000 + parseInt(dateStr.slice(0, 2), 10),
    parseInt(dateStr.slice(2, 4), 10) - 1,
    parseInt(dateStr.slice(4, 6), 10),
    8, 0, 0
  ));
  return { underlying, expiry, strike, type };
}

/**
 * Pick the call contract whose IV best proxies the market: same underlying,
 * not expired, expiring on/after the market's expiry, nearest strike (weighted
 * 3x) and nearest expiry (0.01 per day). Returns null if nothing qualifies or
 * the IV is unusable. No smile interpolation: the IV of the nearest listed
 * strike is used as-is.
 */
export function selectBestCall(contracts, underlying, strike, targetExpiry, now = Date.now()) {
  if (!Array.isArray(contracts) || !targetExpiry || !(strike > 0)) return null;
  const targetMs = new Date(targetExpiry).getTime();
  let best = null;
  let bestScore = Infinity;

  for (const c of contracts) {
    const p = parseOptionSymbol(c.symbol);
    if (!p || p.type !== 'C' || p.underlying !== underlying) continue;
    const expMs = p.expiry.getTime();
    if (expMs < now || expMs < targetMs) continue;
    const iv = parseFloat(c.markIV);
    if (!Number.isFinite(iv) || iv <= 0) continue;

    const strikeDiff = Math.abs(p.strike - strike) / strike;
    const expiryDiffDays = (expMs - targetMs) / (1000 * 60 * 60 * 24);
    const score = strikeDiff * 3 + expiryDiffDays * 0.01;
    if (score < bestScore) {
      bestScore = score;
      best = {
        symbol: c.symbol,
        strike: p.strike,
        expiry: p.expiry,
        impliedVolatility: iv,
        markPrice: parseFloat(c.markPrice),
        indexPrice: parseFloat(c.indexPrice)
      };
    }
  }
  return best;
}

export class BinanceService {
  constructor() {
    this.baseURL = 'https://fapi.binance.com/fapi/v1';
    this.client = axios.create({
      baseURL: this.baseURL,
      timeout: 10000, // 10 second timeout
    });

    // Add request interceptor for logging
    this.client.interceptors.request.use(
      (config) => {
        Logger.debug('BINANCE', `API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        Logger.error('BINANCE', `Request error: ${error.message}`);
        return Promise.reject(error);
      }
    );

    // Add response interceptor for logging and retry logic
    this.client.interceptors.response.use(
      (response) => {
        Logger.debug('BINANCE', `API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      async (error) => {
        Logger.warn('BINANCE', `API Error: ${error.response?.status} ${error.config?.url} - ${error.message}`);

        // Implement simple retry for rate limits (429) or server errors (5xx)
        if (error.response?.status === 429 || (error.response?.status >= 500 && error.response?.status < 600)) {
          const retryCount = error.config.retryCount || 0;
          if (retryCount < 3) {
            const delay = Math.pow(2, retryCount) * 1000; // Exponential backoff: 1s, 2s, 4s
            Logger.info('BINANCE', `Retrying request in ${delay}ms (attempt ${retryCount + 1}/3)`);
            await new Promise(resolve => setTimeout(resolve, delay));
            error.config.retryCount = retryCount + 1;
            return this.client.request(error.config);
          }
        }

        return Promise.reject(error);
      }
    );

    // Separate client for the public Binance European options API
    this.optionsClient = axios.create({
      baseURL: 'https://eapi.binance.com/eapi/v1',
      timeout: 10000,
    });
    this.optionsMarkCache = null;

    // Cache for contract info and funding rates to reduce API calls
    this.contractCache = new Map();
    this.fundingRateCache = new Map();
    this.cacheExpiry = 5 * 60 * 1000; // 5 minutes cache
  }

  async fetchFuturesPrice(symbol) {
    try {
      Logger.info('BINANCE', `Fetching futures price for ${symbol}`);

      const response = await this.client.get('/ticker/price', {
        params: { symbol: symbol.toUpperCase() }
      });

      const data = response.data;
      const priceData = {
        symbol: data.symbol,
        price: parseFloat(data.price),
        timestamp: Date.now()
      };

      Logger.debug('BINANCE', `Fetched price for ${symbol}: $${priceData.price}`);
      return priceData;

    } catch (error) {
      Logger.error('BINANCE', `Failed to fetch futures price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  async fetchMultiplePrices(symbols) {
    try {
      Logger.info('BINANCE', `Fetching futures prices for ${symbols.length} symbols`);

      // Binance API has issues with the symbols parameter, so we'll make individual calls
      const prices = [];
      for (const symbol of symbols) {
        try {
          const priceData = await this.fetchFuturesPrice(symbol);
          prices.push(priceData);
          // Small delay to avoid rate limits
          await new Promise(resolve => setTimeout(resolve, 50));
        } catch (error) {
          Logger.warn('BINANCE', `Failed to fetch price for ${symbol}: ${error.message}`);
        }
      }

      Logger.debug('BINANCE', `Fetched ${prices.length} prices`);
      return prices;

    } catch (error) {
      Logger.error('BINANCE', `Failed to fetch multiple prices: ${error.message}`);
      throw error;
    }
  }

  async fetchFundingRate(symbol) {
    try {
      // Check cache first
      const cacheKey = `funding_${symbol}`;
      const cached = this.fundingRateCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        Logger.debug('BINANCE', `Using cached funding rate for ${symbol}`);
        return cached.data;
      }

      Logger.info('BINANCE', `Fetching funding rate for ${symbol}`);

      const response = await this.client.get('/premiumIndex', {
        params: { symbol: symbol.toUpperCase() }
      });

      const data = response.data;
      const fundingData = {
        symbol: data.symbol,
        fundingRate: parseFloat(data.lastFundingRate),
        markPrice: parseFloat(data.markPrice),
        indexPrice: parseFloat(data.indexPrice),
        estimatedSettlePrice: parseFloat(data.estimatedSettlePrice),
        timestamp: Date.now(),
        nextFundingTime: parseInt(data.nextFundingTime)
      };

      // Cache the result
      this.fundingRateCache.set(cacheKey, {
        data: fundingData,
        timestamp: Date.now()
      });

      Logger.debug('BINANCE', `Fetched funding rate for ${symbol}: ${fundingData.fundingRate}`);
      return fundingData;

    } catch (error) {
      Logger.error('BINANCE', `Failed to fetch funding rate for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  async fetchContractInfo(symbol) {
    try {
      // Check cache first
      const cacheKey = `contract_${symbol}`;
      const cached = this.contractCache.get(cacheKey);
      if (cached && (Date.now() - cached.timestamp) < this.cacheExpiry) {
        Logger.debug('BINANCE', `Using cached contract info for ${symbol}`);
        return cached.data;
      }

      Logger.info('BINANCE', `Fetching contract info for ${symbol}`);

      const response = await this.client.get('/exchangeInfo');

      const contract = response.data.symbols.find(s => s.symbol === symbol.toUpperCase());
      if (!contract) {
        throw new Error(`Contract ${symbol} not found`);
      }

      const contractData = {
        symbol: contract.symbol,
        pair: contract.pair,
        contractType: contract.contractType,
        deliveryDate: contract.deliveryDate,
        onboardDate: contract.onboardDate,
        status: contract.status,
        maintMarginPercent: contract.maintMarginPercent,
        requiredMarginPercent: contract.requiredMarginPercent,
        baseAsset: contract.baseAsset,
        quoteAsset: contract.quoteAsset,
        marginAsset: contract.marginAsset,
        pricePrecision: contract.pricePrecision,
        quantityPrecision: contract.quantityPrecision,
        baseAssetPrecision: contract.baseAssetPrecision,
        quotePrecision: contract.quotePrecision,
        underlyingType: contract.underlyingType,
        underlyingSubType: contract.underlyingSubType,
        settlePlan: contract.settlePlan,
        triggerProtect: contract.triggerProtect,
        filters: contract.filters,
        timestamp: Date.now()
      };

      // Cache the result
      this.contractCache.set(cacheKey, {
        data: contractData,
        timestamp: Date.now()
      });

      Logger.debug('BINANCE', `Fetched contract info for ${symbol}`);
      return contractData;

    } catch (error) {
      Logger.error('BINANCE', `Failed to fetch contract info for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  async calculateExpirationPrice(symbol, expirationDate, currentPrice = null) {
    try {
      Logger.info('BINANCE', `Calculating expiration price for ${symbol} at ${expirationDate}`);

      // Get current price if not provided
      if (!currentPrice) {
        const priceData = await this.fetchFuturesPrice(symbol);
        currentPrice = priceData.price;
      }

      // Get funding rate data
      const fundingData = await this.fetchFundingRate(symbol);

      // Calculate time to expiration in hours
      const now = Date.now();
      const expiryTime = new Date(expirationDate).getTime();
      const hoursToExpiry = (expiryTime - now) / (1000 * 60 * 60);

      if (hoursToExpiry <= 0) {
        Logger.warn('BINANCE', `Expiration date ${expirationDate} is in the past`);
        return currentPrice;
      }

      // Funding rate is paid every 8 hours
      const fundingIntervals = hoursToExpiry / 8;

      // Calculate funding cost impact on price
      // This is a simplified calculation - in reality, funding rates affect price continuously
      const fundingImpact = fundingData.fundingRate * fundingIntervals;

      // For longs: positive funding rate means paying funding, which decreases price
      // For shorts: positive funding rate means receiving funding, which increases price
      // Since we're projecting future price, we need to estimate the direction
      // For simplicity, we'll assume the market moves toward fair value
      const projectedPrice = currentPrice * (1 + fundingImpact * 0.1); // Dampened impact

      const result = {
        symbol,
        currentPrice,
        projectedPrice,
        hoursToExpiry,
        fundingRate: fundingData.fundingRate,
        fundingIntervals,
        fundingImpact,
        expirationDate,
        timestamp: Date.now()
      };

      Logger.debug('BINANCE', `Calculated expiration price for ${symbol}: $${currentPrice} → $${projectedPrice.toFixed(2)}`);
      return result;

    } catch (error) {
      Logger.error('BINANCE', `Failed to calculate expiration price for ${symbol}: ${error.message}`);
      throw error;
    }
  }

  /**
   * Fetch Binance options marks (public eapi endpoint) and return the best
   * matching call for a Polymarket market, or null if none is listed.
   * Marks are cached briefly to avoid refetching per market.
   */
  async fetchOptionsData(underlying, expiry, strikePrice) {
    if (!this.optionsMarkCache || Date.now() - this.optionsMarkCache.timestamp > 60 * 1000) {
      const response = await this.optionsClient.get('/mark');
      this.optionsMarkCache = { data: response.data, timestamp: Date.now() };
    }
    return selectBestCall(this.optionsMarkCache.data, underlying, strikePrice, expiry);
  }
}

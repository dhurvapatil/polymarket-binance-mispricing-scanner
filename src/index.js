// Main entry point for Polymarket-Binance Arbitrage Bot
// Continuous monitoring system for arbitrage opportunities

import { Config } from './utils/config.js';
import { Logger } from './utils/logger.js';
import { PolymarketService } from './services/polymarket.js';
import { BinanceService } from './services/binance.js';
import { ArbitrageService } from './services/arbitrage.js';
import { TelegramService } from './services/telegram.js';

// Global statistics tracking
const globalStats = {
  cyclesRun: 0,
  totalRuntime: 0,
  opportunitiesFound: 0,
  profitableOpportunities: 0,
  apiFailures: 0,
  consecutiveFailures: 0,
  lastSuccessfulCycle: null,
  startTime: new Date(),
  averageCycleTime: 0
};

// Global cycle counter
let globalCycleCounter = 0;

// Service instances (initialized once)
let services = {};

// Monitoring interval reference
let monitoringInterval = null;

// Prevent overlapping cycles
let isRunning = false;

async function initializeServices(config) {
  Logger.info('BOT', '🔧 Initializing services...');

  try {
    services.polymarket = new PolymarketService();
    services.binance = new BinanceService();
    services.telegram = new TelegramService(config.telegramBotToken, config.telegramChatId);
    services.arbitrage = new ArbitrageService(
      services.polymarket,
      services.binance,
      services.telegram,
      { minProfitThreshold: config.minProfitThreshold / 100 } // env value is in percent
    );

    Logger.info('BOT', '✅ All services initialized successfully');
    return true;
  } catch (error) {
    Logger.error('BOT', `❌ Service initialization failed: ${error.message}`);
    return false;
  }
}

async function runMonitoringCycle() {
  // Prevent overlapping cycles
  if (isRunning) {
    Logger.warn('MONITOR', 'Previous cycle still running, skipping...');
    return;
  }

  isRunning = true;
  const cycleId = ++globalCycleCounter;
  const cycleStart = Date.now();

  Logger.info('MONITOR', `=== CYCLE #${cycleId} STARTED ===`);

  try {
    // Phase 1: Polymarket Data Fetch
    const polyStart = Date.now();
    Logger.info('MONITOR', 'Fetching Polymarket data...');
    const allMarkets = await services.polymarket.fetchActiveMarkets();
    const cryptoMarkets = services.polymarket
      .filterCryptoMarkets(allMarkets)
      .map(m => services.polymarket.calculateImpliedProbabilities(m)); // sets .probability (was never called)
    const polyTime = Date.now() - polyStart;
    Logger.info('MONITOR', `Polymarket: ${allMarkets.length} total → ${cryptoMarkets.length} crypto (${polyTime}ms)`);

    // Phase 2: Binance Price Fetch
    const binanceStart = Date.now();
    Logger.info('MONITOR', 'Fetching Binance prices...');
    const prices = await services.binance.fetchMultiplePrices(['BTCUSDT', 'ETHUSDT', 'SOLUSDT']);
    const binanceTime = Date.now() - binanceStart;
    Logger.info('MONITOR', `Binance: ${prices.length} prices fetched (${binanceTime}ms)`);

    // Phase 3: Arbitrage Calculation
    const arbStart = Date.now();
    Logger.info('MONITOR', 'Calculating arbitrage opportunities...');
    const opportunities = await services.arbitrage.matchMarkets(cryptoMarkets, prices);
    const profitable = await services.arbitrage.filterOpportunities(opportunities);
    const arbTime = Date.now() - arbStart;

    // Detailed opportunity logging
    Logger.info('MONITOR', `Arbitrage: ${opportunities.length} analyzed → ${profitable.length} profitable (${arbTime}ms)`);

    if (profitable.length > 0) {
      Logger.info('MONITOR', '🚨 PROFITABLE OPPORTUNITIES FOUND:');
      profitable.forEach((opp, index) => {
        Logger.info('MONITOR', `  ${index + 1}. ${opp.market.question.substring(0, 60)}...`);
        Logger.info('MONITOR', `     Profit: ${(opp.arbitrage.profitMargin * 100).toFixed(2)}% | Price: $${opp.futures.price}`);
        Logger.info('MONITOR', `     Direction: ${opp.recommendation} | Confidence: ${opp.confidence}`);
        Logger.info('MONITOR', `     Polymarket: https://polymarket.com/market/${opp.market.id}`);
        Logger.info('MONITOR', `     Binance: https://www.binance.com/en/futures/${opp.futures.symbol}`);
        Logger.info('MONITOR', `     Probability Delta: ${(opp.arbitrage.probabilityDelta * 100).toFixed(2)}%`);
        Logger.info('MONITOR', `     Net Profit: $${opp.arbitrage.netProfit.toFixed(2)} | Fees: $${opp.arbitrage.totalFees.toFixed(2)}`);
      });
    }

    // Phase 4: Telegram Notifications (automatic via ArbitrageService)
    // Already handled in filterOpportunities()

    const totalTime = Date.now() - cycleStart;
    Logger.info('MONITOR', `=== CYCLE #${cycleId} COMPLETED in ${totalTime}ms ===`);

    // Update running statistics
    updateCycleStatistics(cycleId, totalTime, opportunities.length, profitable.length, true);

  } catch (error) {
    const errorTime = Date.now() - cycleStart;
    Logger.error('MONITOR', `=== CYCLE #${cycleId} FAILED after ${errorTime}ms: ${error.message} ===`);

    // Log detailed error context
    if (error.response) {
      Logger.error('MONITOR', `API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    } else if (error.code) {
      Logger.error('MONITOR', `Network Error: ${error.code} - ${error.message}`);
    }

    // Continue to next cycle - don't crash
    Logger.info('MONITOR', 'Continuing to next monitoring cycle...');

    // Update failure statistics
    updateCycleStatistics(cycleId, errorTime, 0, 0, false);

  } finally {
    isRunning = false;
  }
}

function updateCycleStatistics(cycleId, duration, opportunities, profitable, success) {
  globalStats.cyclesRun++;
  globalStats.totalRuntime += duration;
  globalStats.opportunitiesFound += opportunities;
  globalStats.profitableOpportunities += profitable;
  globalStats.averageCycleTime = globalStats.totalRuntime / globalStats.cyclesRun;

  if (success) {
    globalStats.lastSuccessfulCycle = new Date();
    globalStats.consecutiveFailures = 0;
  } else {
    globalStats.apiFailures++;
    globalStats.consecutiveFailures++;
  }

  // Log summary every 10 cycles
  if (cycleId % 10 === 0) {
    Logger.info('STATS', `Summary after ${cycleId} cycles:`);
    Logger.info('STATS', `  Average cycle time: ${globalStats.averageCycleTime.toFixed(0)}ms`);
    Logger.info('STATS', `  Total opportunities analyzed: ${globalStats.opportunitiesFound}`);
    Logger.info('STATS', `  Profitable opportunities found: ${globalStats.profitableOpportunities}`);
    Logger.info('STATS', `  Success rate: ${((globalStats.cyclesRun - globalStats.apiFailures) / globalStats.cyclesRun * 100).toFixed(1)}%`);
    Logger.info('STATS', `  API failure rate: ${(globalStats.apiFailures / globalStats.cyclesRun * 100).toFixed(1)}%`);

    if (globalStats.consecutiveFailures > 0) {
      Logger.warn('STATS', `  Consecutive failures: ${globalStats.consecutiveFailures}`);
    }
  }

  // Alert on consecutive failures
  if (globalStats.consecutiveFailures >= 3) {
    Logger.error('STATS', `🚨 ALERT: ${globalStats.consecutiveFailures} consecutive cycle failures detected!`);
  }
}

function startMonitoring(config) {
  const intervalMs = config.checkFrequencyMs || 10000; // Default 10 seconds

  Logger.info('BOT', `🔄 Starting continuous monitoring (every ${intervalMs}ms)...`);
  Logger.info('BOT', '💡 Press Ctrl+C to stop monitoring gracefully');

  // Start the monitoring loop
  monitoringInterval = setInterval(runMonitoringCycle, intervalMs);

  // Run first cycle immediately
  setTimeout(runMonitoringCycle, 1000);
}

function setupGracefulShutdown() {
  process.on('SIGINT', () => {
    Logger.info('BOT', '🛑 Shutdown signal received - stopping monitoring...');

    // Stop the monitoring loop
    if (monitoringInterval) {
      clearInterval(monitoringInterval);
      monitoringInterval = null;
    }

    // Log final comprehensive statistics
    const runtimeMinutes = Math.floor((Date.now() - globalStats.startTime.getTime()) / 1000 / 60);
    Logger.info('BOT', '📊 FINAL STATISTICS:');
    Logger.info('BOT', `  Total runtime: ${runtimeMinutes} minutes`);
    Logger.info('BOT', `  Cycles completed: ${globalStats.cyclesRun}`);
    Logger.info('BOT', `  Average cycle time: ${globalStats.averageCycleTime.toFixed(0)}ms`);
    Logger.info('BOT', `  Total opportunities analyzed: ${globalStats.opportunitiesFound}`);
    Logger.info('BOT', `  Profitable opportunities found: ${globalStats.profitableOpportunities}`);
    Logger.info('BOT', `  Telegram notifications sent: ${services.telegram ? services.telegram.getStatistics().totalSent : 0}`);
    Logger.info('BOT', `  Overall success rate: ${((globalStats.cyclesRun - globalStats.apiFailures) / globalStats.cyclesRun * 100).toFixed(1)}%`);
    Logger.info('BOT', `  API failure count: ${globalStats.apiFailures}`);

    if (globalStats.profitableOpportunities > 0) {
      Logger.info('BOT', `  Profit notifications sent: ${globalStats.profitableOpportunities}`);
    }

    Logger.info('BOT', '✅ Bot shutdown complete');
    process.exit(0);
  });

  process.on('SIGTERM', () => {
    // Same as SIGINT
    process.emit('SIGINT');
  });
}

async function main() {
  try {
    Logger.info('BOT', '🚀 Starting Polymarket-Binance Arbitrage Bot...');

    // Load and validate configuration
    const config = Config.load();
    Logger.initialize(config);

    Logger.info('BOT', `Configuration loaded successfully`);
    Logger.info('BOT', `Minimum profit threshold: ${config.minProfitThreshold}%`);
    Logger.info('BOT', `Check frequency: ${config.checkFrequencyMs || 10000}ms`);
    Logger.info('BOT', `Market filters: ${config.marketFilters.join(', ')}`);
    Logger.info('BOT', `Binance credentials available: ${config.hasBinanceCredentials()}`);

    // Initialize all services
    const servicesReady = await initializeServices(config);
    if (!servicesReady) {
      Logger.error('BOT', 'Failed to initialize services - exiting');
      process.exit(1);
    }

    // Setup graceful shutdown
    setupGracefulShutdown();

    // Start continuous monitoring
    startMonitoring(config);

    // Bot is now running continuously - this function doesn't return

  } catch (error) {
    Logger.error('BOT', `Failed to start bot: ${error.message}`);
    process.exit(1);
  }
}

main();
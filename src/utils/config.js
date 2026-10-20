import dotenv from 'dotenv';
import { Logger } from './logger.js';

// Load environment variables from .env file
dotenv.config();

export class Config {
  constructor() {
    this.telegramBotToken = process.env.TELEGRAM_BOT_TOKEN;
    this.telegramChatId = process.env.TELEGRAM_CHAT_ID;
    this.binanceApiKey = process.env.BINANCE_API_KEY;
    this.binanceApiSecret = process.env.BINANCE_API_SECRET || process.env.BINANCE_SECRET_KEY; // BINANCE_SECRET_KEY accepted as legacy alias
    this.minProfitThreshold = parseFloat(process.env.MIN_PROFIT_THRESHOLD || '2.0');
    this.checkFrequencyMs = parseInt(process.env.CHECK_FREQUENCY_MS || '30000');
    this.marketFilters = (process.env.MARKET_FILTERS || 'BTC,ETH').split(',');
    this.logLevel = process.env.LOG_LEVEL || 'info';
    this.logToFile = process.env.LOG_TO_FILE === 'true';
  }

  static load() {
    const config = new Config();

    // Validate required configuration
    const requiredFields = [
      { key: 'telegramBotToken', name: 'TELEGRAM_BOT_TOKEN' },
      { key: 'telegramChatId', name: 'TELEGRAM_CHAT_ID' }
    ];

    const missingFields = requiredFields.filter(field => !config[field.key]);

    if (missingFields.length > 0) {
      const fieldNames = missingFields.map(field => field.name).join(', ');
      Logger.error('CONFIG', `Missing required environment variables: ${fieldNames}`);
      Logger.error('CONFIG', 'Please copy config/.env.example to .env and fill in the required values');
      throw new Error(`Missing required configuration: ${fieldNames}`);
    }

    // Validate numeric fields
    if (isNaN(config.minProfitThreshold) || config.minProfitThreshold < 0) {
      throw new Error('MIN_PROFIT_THRESHOLD must be a valid positive number');
    }

    if (isNaN(config.checkFrequencyMs) || config.checkFrequencyMs < 1000) {
      throw new Error('CHECK_FREQUENCY_MS must be a valid number >= 1000ms');
    }

    Logger.info('CONFIG', 'Configuration loaded successfully');
    return config;
  }

  // Helper method to get Binance credentials (optional)
  hasBinanceCredentials() {
    return !!(this.binanceApiKey && this.binanceApiSecret);
  }
}
import { Logger } from '../src/utils/logger.js';

// Unknown level => shouldLog() is false for every message: silences logs in tests.
Logger.logLevel = 'silent';

'use strict';

require('dotenv').config();

const createLogger = require('./utils/logger');
const log = createLogger('Config');

function requireEnv(key) {
  const value = process.env[key];
  if (!value) {
    log.error(`${key}: MISSING`);
    process.exit(1);
  }
  log.info(`${key}: loaded`);
  return value;
}

function optionalEnv(key, defaultValue) {
  const value = process.env[key];
  if (value) {
    log.info(`${key}: loaded`);
  } else {
    log.info(`${key}: using default (${defaultValue})`);
  }
  return value || defaultValue;
}

const config = {
  DATABASE_URL:        requireEnv('DATABASE_URL'),
  JWT_SECRET:          requireEnv('JWT_SECRET'),
  JWT_REFRESH_SECRET:  requireEnv('JWT_REFRESH_SECRET'),
  PORT:                optionalEnv('PORT', '10000'),
  NODE_ENV:            optionalEnv('NODE_ENV', 'development'),
};

module.exports = config;

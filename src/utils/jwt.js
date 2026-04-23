'use strict';

const jwt = require('jsonwebtoken');
const createLogger = require('./logger');
const log = createLogger('JWT');
const config = require('../config');

function signAccess(userId) {
  const token = jwt.sign({ userId }, config.JWT_SECRET, { expiresIn: '15m' });
  log.debug(`Access token issued for userId: ${userId}`);
  return token;
}

function signRefresh(userId) {
  const token = jwt.sign({ userId }, config.JWT_REFRESH_SECRET, { expiresIn: '30d' });
  log.debug(`Refresh token issued for userId: ${userId}`);
  return token;
}

function verifyAccess(token) {
  try {
    return jwt.verify(token, config.JWT_SECRET);
  } catch (err) {
    log.warn(`Token verification failed: ${err.message}`);
    throw err;
  }
}

function verifyRefresh(token) {
  try {
    return jwt.verify(token, config.JWT_REFRESH_SECRET);
  } catch (err) {
    log.warn(`Refresh token verification failed: ${err.message}`);
    throw err;
  }
}

module.exports = { signAccess, signRefresh, verifyAccess, verifyRefresh };

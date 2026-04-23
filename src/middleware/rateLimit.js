'use strict';

const rateLimit = require('express-rate-limit');
const createLogger = require('../utils/logger');
const log = createLogger('RateLimit');

const authLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    log.warn(`Rate limit exceeded for IP: ${req.ip} on ${req.path}`);
    res.status(429).json({ error: 'Too many requests, please try again later' });
  },
});

module.exports = { authLimiter };

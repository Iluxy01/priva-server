'use strict';

const { verifyAccess } = require('../utils/jwt');
const createLogger = require('../utils/logger');
const log = createLogger('Auth');

/**
 * JWT authentication middleware.
 * Attaches req.userId on success.
 */
function authMiddleware(req, res, next) {
  const header = req.headers['authorization'];

  if (!header || !header.startsWith('Bearer ')) {
    log.warn(`Request without token: ${req.method} ${req.path}`);
    return res.status(401).json({ error: 'Authorization required' });
  }

  const token = header.slice(7);

  try {
    const payload = verifyAccess(token);
    log.debug(`Token valid for userId: ${payload.userId}`);
    req.userId = payload.userId;
    next();
  } catch {
    log.warn('Invalid token attempt');
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = authMiddleware;

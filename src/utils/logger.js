'use strict';

const COLORS = {
  INFO:  '\x1b[32m',  // green
  WARN:  '\x1b[33m',  // yellow
  ERROR: '\x1b[31m',  // red
  DEBUG: '\x1b[90m',  // grey
  RESET: '\x1b[0m',
};

function formatDate() {
  const now = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`
  );
}

function write(level, moduleName, message, err) {
  if (level === 'DEBUG' && process.env.NODE_ENV === 'production') return;

  const color = COLORS[level] || COLORS.RESET;
  const line = `[${formatDate()}] ${color}[${level}]${COLORS.RESET} [${moduleName}] ${message}`;
  if (level === 'ERROR') {
    console.error(line);
    if (err && err.stack) {
      console.error(`${COLORS.ERROR}${err.stack}${COLORS.RESET}`);
    }
  } else {
    console.log(line);
  }
}

/**
 * Factory: const log = require('../utils/logger')('ModuleName')
 * NEVER log: passwords, private keys, message payload contents
 */
module.exports = function createLogger(moduleName) {
  return {
    info:  (msg)       => write('INFO',  moduleName, msg),
    warn:  (msg)       => write('WARN',  moduleName, msg),
    error: (msg, err)  => write('ERROR', moduleName, msg, err),
    debug: (msg)       => write('DEBUG', moduleName, msg),
  };
};

// Morgan stream for HTTP request logging
const httpLog = createLogger => {
  const log = createLogger('HTTP');
  return { write: (msg) => log.info(msg.trim()) };
};

module.exports.httpStream = httpLog(module.exports);

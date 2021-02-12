// *** main dependencies *** //
const cors      = require('cors');
const debug     = require('debug')('odin-portal:app:cors');
const settings  = require('./');

// *** cors setup *** //
let whitelist   = settings['cors']['whitelist'];
let corsOptions = {
  origin: function (origin, callback) {
    // callback(null, true);
    if (origin === undefined || whitelist.indexOf(origin) !== -1) {
      callback(null, true)
    }
    else {
      debug(`ORIGIN REJECTED -- ${origin}`)
      callback(new Error('Not allowed by CORS'))
    }
  }
}

debug(`CORS Whitelisted :: ${whitelist.join(', ')}`);

module.exports = cors(corsOptions);

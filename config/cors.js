// *** main dependencies *** //
const cors  = require('cors');
const debug = require('debug')('odin-portal:app:cors');

// *** cors setup *** //
let whitelist   = [ 'http://claim.odinblockchain.org', 'https://claim.odinblockchain.org' ];
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

module.exports = cors(corsOptions);

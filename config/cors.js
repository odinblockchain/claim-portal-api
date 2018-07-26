// *** main dependencies *** //
const cors = require('cors');

// *** cors setup *** //
// let whitelist   = ['http://localhost:4200'];
let corsOptions = {
  origin: function (origin, callback) {
    // Accept all requests... for now...
    callback(null, true);
    // if (origin === undefined || whitelist.indexOf(origin) !== -1) {
    //   callback(null, true)
    // }
    // else {
    //   callback(new Error('Not allowed by CORS'))
    // }
  }
}

module.exports = cors(corsOptions);

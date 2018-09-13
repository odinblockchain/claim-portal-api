const package     = require('../package.json');
const db          = require('../lib/database');
const mongoose    = require('mongoose');
const AuthIP      = mongoose.model('AuthIP');
const settings    = require('../config/');
const debug       = require('debug')('odin-portal:script:verifySMS');
const Raven       = require('raven');
const env         = process.env.NODE_ENV || 'development';
const moment      = require('moment');
const Flag        = mongoose.model('Flag');
const User        = mongoose.model('User');

Raven.config(settings['integrations']['sentry']['DSN'], {
  release: package.version,
  environment: env
}).install();

let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

let userAddress = process.argv[2] || '';

db.connect(dbString)
.then(() => {
  User.find({ email: userAddress })
  .exec((err, user) => {
    if (err) {
      console.log(err);
      return process.exit(0);
    }

    if (!user) {
      console.log('USER NOT FOUND');
      return process.exit(0);
    }

    user.forceVerifySMS()
    .then((status) => {
      console.log(`Verfied SMS`);
      setTimeout(() => {
        process.exit(1);
      }, 5000);
    })
    .catch((err) => {
      console.log(err);
    });
  });
})
.catch((err) => {
  Raven.captureException('Unable to run script FixCreatedAt', {
    tags: { script: 'fixCreatedAt' },
    extra: {
      error: (err.message) ? err.message : err
    }
  });
  
  debug(`Exception Raised -- MongoDB Connect`);
  process.exit(1);
});


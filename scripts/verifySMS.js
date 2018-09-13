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

    user.phone_verified = true;
    user.save((err) => {
      if (err) {
        console.log(err);
        return process.exit(0);
      }

      Flag.addFlag(user._id, 'phoneValidation', 'force_phone_verify')
      .then((added) => {
        console.log('Completed');
        return process.exit(1);
      })
      .catch((err) => {
        console.log(err);
        return process.exit(0);
      });
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


const package   = require('../package.json');
const db        = require('../lib/database');
const mongoose  = require('mongoose');
const User      = mongoose.model('User');
const settings  = require('../config/');
const debug     = require('debug')('odin-portal:script:refreshBalances');
const metrics   = require('../lib/metrics');
const Raven     = require('raven');
const env       = process.env.NODE_ENV || 'development';

Raven.config(settings['integrations']['sentry']['DSN'], {
  release: package.version,
  environment: env
}).install();

let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

db.connect(dbString)
.then(() => {

  User.fetchLockedClaimTotals()
  .then((totalLocked) => {
    debug(`Total Claim Locked: ${totalLocked}`);
    metrics.measurement('claim_lock_total', totalLocked);
    
    setTimeout(() => {
      process.exit(0);
    }, 5000);
  })
  .catch((err) => {
    console.log('Unable to refresh claim locked totals');
    Raven.captureException('Locked Totals refresh error', {
      tags: { script: 'fetchTotalClaimed' },
      extra: {
        error: err
      }
    });

    setTimeout(() => {
      process.exit(1);
    }, 5000);
  });
})
.catch((err) => {
  console.log('Unable to refresh claim locked totals');
  Raven.captureException('Locked Totals refresh error', {
    tags: { script: 'fetchTotalClaimed' },
    extra: {
      error: err
    }
  });
  
  setTimeout(() => {
    process.exit(1);
  }, 5000);
});


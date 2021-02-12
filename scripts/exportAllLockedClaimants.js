const package   = require('../package.json');
const db        = require('../lib/database');
const mongoose  = require('mongoose');
const User      = mongoose.model('User');
const Notification = mongoose.model('Notification');
const settings  = require('../config/');
const debug     = require('debug')('odin-portal:script:exportSubscriptions');
const metrics   = require('../lib/metrics');
const Raven     = require('raven');
const moment    = require('moment');
const fs        = require('fs');
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

  let list = [];
  
  User.find({ balance_locked: true }, { email: true })
  .populate('user')
  .exec((err, usersList) => {
    if (err) {
      console.log(err);
      return process.exit(0);
    }
    
    usersListClean = usersList.map(_user => {
      return {
        email: _user.email,
      };
    });

    const replacer = function(key, value) { return value === null ? '' : value };
    const fields = Object.keys(usersListClean[0]);

    let csv = usersListClean.map(function(row) {
      return fields.map(function(fieldName){
        return JSON.stringify(row[fieldName], replacer)
      }).join(',')
    });

    csv.unshift(fields.join(','));

    fs.writeFile(`./export/allLockedClaimants-${moment().format('YYYY-MM-DD_X')}.csv`, csv.join('\r\n'), (err) => {
      if (err) {
        console.error('EXPORT ERROR', err);
        process.exit(1);
      };

      console.log(`Exported Subscribed Claimants:
      ${csv.join('\r\n')}`);

      console.log(`Total Rows: ${csv.length}`);

      setTimeout(() => {
        process.exit(1);
      }, 5000);
    });

    // return process.exit(0);
  });
})
.catch((err) => {
  console.log('Unable to export subscribers');
  Raven.captureException('Export subscribers error', {
    tags: { script: 'exportSubscribedClaimants' },
    extra: {
      error: err
    }
  });
  
  setTimeout(() => {
    process.exit(1);
  }, 5000);
});

// metrics.measurement('registration', req.body.timestampDiff);



const Snapshot        = require('../data/snapshot.json');
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

let differences   = [];
let differenceSum = 0;

let updateUser = (user) => {
  return new Promise((resolve, reject) => {
    let snapshotAddress = Snapshot['addressList'].find((addr) => {
      return addr['address'] === user.wallet;
    });
    
    if (!snapshotAddress) {
      debug(`Address not found (${user._id})`, err);
      return resolve(false);
    }
    else {
      let diff = Number(user.balance_locked_sum) - Number(snapshotAddress.balance);
      differences.push(diff);
      differenceSum = differenceSum + diff;
      user.balance_locked_diff = diff;

      user.save((err, _u) => {
        if (err) {
          debug(`Unable to save user (${user._id})`, err);
          return resolve(false);
        }

        return resolve(true);
      })
    }
  });
};

db.connect(dbString)
.then(() => {
  console.log('Working Snapshot Comparison...');
  
  User.find()
  .populate('user')
  .exec((err, users) => {
    if (err) {
      console.log(err);
      return process.exit(0);
    }
    
    let todos = [];
    todos = users.map(_user => {
      return updateUser(_user);
    });

    debug(`Snapshot Comparison
    Total Users: ${todos.length}`);

    Promise.all(todos)
    .then((results) => {
      let successfulUpdates = results.filter(r => (r === true)).length;
      let failedUpdates = results.filter(r => (r === false)).length;

      debug(differences);
      console.log('Snapshot Comparsion Complete');
      debug(`[ Results ]
      Successful Updates: ${successfulUpdates}
      Failed Updates: ${failedUpdates}
      ...
      Difference Sum: ${differenceSum}
      Average Difference: ${(differenceSum / differences.length)}`);

      setTimeout(() => {
        process.exit(0);
      }, 2000);
    })
    .catch((err) => {
      console.log('Failed to compare snapshot', err);
      setTimeout(() => {
        process.exit(1);
      }, 2000);
    });
  });
})
.catch((err) => {
  console.log('Failed to compare snapshot', err);
  setTimeout(() => {
    process.exit(1);
  }, 2000);
});

// metrics.measurement('registration', req.body.timestampDiff);


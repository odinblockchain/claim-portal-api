const package   = require('../package.json');
const db        = require('../lib/database');
const mongoose  = require('mongoose');
const User      = mongoose.model('User');
const Notification = mongoose.model('Notification');
const settings  = require('../config/');
const debug     = require('debug')('odin-portal:script:claimUpdateNotify');
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

  console.log(process.argv.join(' '));
  let message = process.argv.join(' ');
  message = message.split('~~')[1];
  if (message.length > 120) return console.log('Message too long!', message.length);
  

  Notification.find({ 'sms.myclaim': true })
  .populate('user')
  .exec((err, notificationList) => {
    if (err) {
      console.log(err);
      return process.exit(0);
    }

    let todo = notificationList.map(_notifyUser => _notifyUser.user.sendSMS(message));

    Promise.all(todo)
    .then((completed) => {
      console.log('COMPLETED');
      return process.exit(1);
    })
    .catch((err) => {
      console.log('Unable to refresh claim balances');
      Raven.captureException('Balance refresh error', {
        tags: { script: 'refreshBalances' },
        extra: {
          error: err
        }
      });
      
      setTimeout(() => {
        process.exit(1);
      }, 5000);
    });

    // for (let i=0; i < notificationList.length; i++) {
    //   notificationList[i].user.sendSMS('This is a test')
    //   .then()
    //   .catch((err) => {
    //     debug(`FAILED SMS Notification LockedClaim - user:${user._id}`);
    //     Raven.captureException('Unable to deliver SMS Notification LockedClaim', {
    //       level: 'error',
    //       extra: {
    //         code: (err.code) ? err.code : '',
    //         message: (err.message) ? err.message : ''
    //       }
    //     });
    // }
    // console.log(users);

    // return process.exit(1);
  });
})
.catch((err) => {
  console.log('Unable to refresh claim balances');
  Raven.captureException('Balance refresh error', {
    tags: { script: 'refreshBalances' },
    extra: {
      error: err
    }
  });
  
  setTimeout(() => {
    process.exit(1);
  }, 5000);
});

// metrics.measurement('registration', req.body.timestampDiff);


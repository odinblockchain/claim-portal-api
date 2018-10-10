const package   = require('../package.json');
const db        = require('../lib/database');
const mongoose  = require('mongoose');
const User      = mongoose.model('User');
const Notification = mongoose.model('Notification');
const settings  = require('../config/');
const debug     = require('debug')('odin-portal:script:adjustClaimStatus');
const metrics   = require('../lib/metrics');
const Raven     = require('raven');
const env       = process.env.NODE_ENV || 'development';

Raven.config(settings['integrations']['sentry']['DSN'], {
  release: package.version,
  environment: env
}).install();

let args = process.argv.slice(2);
if (args.length != 2) {
  console.log(`Missing Email and Status.
  Usage: node script/adjustClaimStatus.js user@website.com accepted`);
  process.exit(1);
}

let email   = args.shift();
let message = args.shift();

let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

db.connect(dbString)
.then(() => {

  User.findOne({ email: email })
  .exec((err, user) => {
    if (err || !user) {
      console.log(`Unable to find user: ${email}`);
      if (err) console.log(err);
      return process.exit(1);
    }

    user.sendSMS(message)
    .then((sent) => {
      console.log(`Added SMS to queue.
      user:     ${email}
      message:  ${message}`);
      return process.exit(0);
    })
    .catch((err) => {
      console.log(`Unable to send SMS to user: ${email}`);
      console.log(err);
      return process.exit(1);
    });
  });
})
.catch((err) => {
  console.log('Unable to initiate DB session for adjustClaimStatus');
  Raven.captureException('Adjust Claim Status error', {
    tags: { script: 'adjustClaimStatus' },
    extra: {
      error: err
    }
  });
  
  setTimeout(() => {
    process.exit(1);
  }, 5000);
});

// metrics.measurement('registration', req.body.timestampDiff);


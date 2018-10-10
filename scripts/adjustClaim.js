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

let email = args.shift();
let status = args.shift();

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

    user.claim_status = status;

    user.save((err, _u) => {
      if (err) {
        console.log(`Unable to update user: ${email}`);
        if (err) console.log(err);
        return process.exit(1);
      }

      if (user.claim_status === 'approved') {
        SMS = `Your ODIN claim status is now 'Approved'. Check your claim dashboard for details.`;
        emailContent = `This is a notification to let you know that your ODIN Claim Status has been updated to 'APPROVED'. You can begin withdrawing your ODIN if withdraws are enabled. Please visit your ODIN Claim Dashboard for details.`;
      }
      else if (user.claim_status === 'declined') {
        SMS = `Your ODIN claim status has been 'Declined'. Check your claim dashboard for details.`;
        emailContent = `This is a notification to let you know that your ODIN Claim Status has been updated to 'DECLINED'. Please reach out to our support team (claimsupport@odinblockchain.org). Visit your ODIN Claim Dashboard for details.`;
      }
      else if (user.claim_status === 'pending') {
        SMS = `Your ODIN claim status is currently 'Pending'. Check your claim dashboard for details.`;
        emailContent = `This is a notification to let you know that your ODIN Claim Status has been updated to 'PENDING'. We are currently assessing your claim and will update your account and attempt to notify you of any additional updates. Visit your ODIN Claim Dashboard for details.`;
      }

      user.sendClaimUpdate('ODIN Claim Status Updated', emailContent, SMS)
      .then((sent) => {
        console.log(sent);

        console.log(`Updated user(${email}) identity status and claim status`);
        return process.exit(0);
      })
    })
    .catch((err) => {
      console.log(`Unable to update claim status for user: ${email}`);
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


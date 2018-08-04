const package     = require('../package.json');
const db          = require('../lib/database');
const mongoose    = require('mongoose');
const AuthIP      = mongoose.model('AuthIP');
const settings    = require('../config/');
const debug       = require('debug')('odin-portal:script:fixCreationDate');
const Raven       = require('raven');
const env         = process.env.NODE_ENV || 'development';
const moment      = require('moment');

Raven.config(settings['integrations']['sentry']['DSN'], {
  release: package.version,
  environment: env
}).install();

let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

function fixUser(user, createdAt) {
  return new Promise((resolve, reject) => {
    let fixedTime = (moment(createdAt).unix() * 1000);

    debug(`Fix User.created_at -- ${user.created_at} ==> ${fixedTime}`);
  
    user.set({ created_at: fixedTime })
    user.save(((err, updatedUser) => {
      if (err) {
        Raven.captureException('Unable to fix createdAt for user', {
          tags: { script: 'fixCreatedAt' },
          extra: {
            error: (err.message) ? err.message : err,
            user: user
          }
        });
        debug(`Exception Raised -- User ${user._id}`);
        return resolve(user);
      }
  
      resolve(updatedUser);
    }));
  });
}

db.connect(dbString)
.then(() => {
  AuthIP.find({})
  .populate('user')
  .exec((err, authIps) => {
    if (err) {
      Raven.captureException('Unable to pull AuthIPs', {
        tags: { script: 'fixCreatedAt' },
        extra: {
          error: (err.message) ? err.message : err
        }
      });
      debug(`Exception Raised -- AuthIP`);
      console.log('Unable to start script');
      process.exit(1);
    }

    let userIds = [];
    let usersFixPromises = authIps.map((ip) => {
      if (userIds.find(user => user._id === ip.user._id))
        return Promise.resolve(ip.user);

      userIds.push(ip.user._id);
      return fixUser(ip.user, ip.createdAt)
    });

    Promise.all(usersFixPromises)
    .then((fixedUsers) => {
      debug(`Finished. Fixed ${userIds.length} users.`);
      process.exit(0);
    })
    .catch((err) => {
      Raven.captureException('Unable to fix createdAt', {
        tags: { script: 'fixCreatedAt' },
        extra: {
          error: (err.message) ? err.message : err
        }
      });
      debug(`Exception Raised -- Promise.all`);
      process.exit(1);
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


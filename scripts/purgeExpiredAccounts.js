const package     = require('../package.json');
const db          = require('../lib/database');
const mongoose    = require('mongoose');
const User        = mongoose.model('User');
const PurgedUser  = mongoose.model('PurgedUser');
const AuthIP      = mongoose.model('AuthIP');
const Request     = mongoose.model('Request');
const settings    = require('../config/');
const debug       = require('debug')('odin-portal:script:purgeExpiredAccounts');
const metrics     = require('../lib/metrics');
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

// Determine purge time
let now = moment().utc();
now.subtract(30, 'minutes');

/**
 * Remove any AuthIPs related to a user,
 * returns an array of IPs
 * @param {User} user 
 */
function removeAuthByUser(user) {
  return new Promise((resolve, reject) => {
    AuthIP.find({ user: user._id })
    .exec((err, ips) => {
      if (err) {
        Raven.captureException('Unable to find Auths to remove', {
          tags: { script: 'PurgeExpiredAccounts' },
          extra: {
            error: (err.message) ? err.message : err,
            user: user
          }
        });
        debug('Exception Raised while finding Auths for User', user._id);
        return resolve([]);
      }

      let ipList = ips.map(ip => ip.ip);

      AuthIP.deleteMany({ user: user._id })
      .exec((err) => {
        if (err) {
          Raven.captureException('Unable to remove Auths for user', {
            tags: { script: 'PurgeExpiredAccounts' },
            extra: {
              error: (err.message) ? err.message : err,
              user: user
            }
          });

          debug('Exception Raised while removing Auths for User', user._id);
          return resolve([]);
        }

        return resolve(ipList);
      });
    });
  });
}

/**
 * Removes any active requests related to a user.
 * @param {User} user 
 */
function removeRequestsByUser(user) {
  return new Promise((resolve, reject) => {
    Request.deleteMany({ user: user._id })
    .exec((err) => {
      if (err) {
        Raven.captureException('Unable to remove Requests for user', {
          tags: { script: 'PurgeExpiredAccounts' },
          extra: {
            error: (err.message) ? err.message : err,
            user: user
          }
        });
        debug('Exception Raised while removing Requests for User', user._id);
        return resolve(false);
      }

      return resolve(true);
    });
  });
}

/**
 * Removes a user from the User collection.
 * @param {User} user
 */
function removeUser(user) {
  return new Promise((resolve, reject) => {
    User.findByIdAndRemove(user._id)
    .exec((err, user) => {
      if (err) {
        Raven.captureException('Unable to remove user', {
          tags: { script: 'PurgeExpiredAccounts' },
          extra: {
            error: (err.message) ? err.message : err,
            user: user
          }
        });
        debug('Exception Raised while removing User', user._id);
        return resolve(false);
      }

      return resolve(user);
    });
  });
}

/**
 * Creates a PurgeUser record using a user document and an array of IP addresses.
 * @param {User} user 
 * @param {Array} ips 
 */
function createPurgeRecord(user, ips) {
  return new Promise((resolve, reject) => {
    let purgedUser = new PurgedUser({
      type:             'system',
      email:            user.email,
      wallet:           user.wallet,
      auth_ips:         ips,
      account_created:  user.created_at
    });

    // console.log('purgeuser', purgedUser);

    purgedUser.save((err, purged) => {
      if (err) {
        Raven.captureException('Unable to create purge record', {
          tags: { script: 'PurgeExpiredAccounts' },
          extra: {
            error: (err.message) ? err.message : err,
            user: user
          }
        });
        debug(`Unable to create PURGE RECORD for user:${user.email}`);
        return resolve(false);
      }

      resolve(purged)
    });
  });
}

/**
 * Purges a user document.
 * @param {User} user 
 */
function purgeAccount(user) {
  return new Promise((resolve, reject) => {
    Promise.all([removeAuthByUser(user), removeRequestsByUser(user)])
    .then(([removedIps, requestStatus]) => {

      removeUser(user)
      .then((removed) => {
        if (!removed)
          return resolve(false);

        debug(`PURGED user:${user.email} [${now.diff(user.created_at, 'minutes')} minutes expired]`);

        createPurgeRecord(user, removedIps.join(','))
        .then((createdRecord) => {
          if (!createdRecord)
            debug(`PUGE RECORD not created, user:${user.email}`);
          else
            debug(`PURGE RECORD created, user:${user.email}`)
          
          resolve(createdRecord);
        });
      });
    });
  });
};

db.connect(dbString)
.then(() => {

  User.find({ email_verified: false })
  .exec((err, users) => {

    let purgedAccountPromises = users.filter(user => user.created_at < (now.unix() * 1000))
    .map((user) => {
      return purgeAccount(user);
    });

    debug(`accounts eligible for purging... ${purgedAccountPromises.length}/${users.length}`)

    Promise.all(purgedAccountPromises)
    .then(purgedAccounts => {
      debug(`PURGED ${purgedAccounts.length} users`);
      process.exit(0);
    })
    .catch((err) => {
      Raven.captureException('Unable to purge accounts', {
        tags: { script: 'PurgeExpiredAccounts' },
        extra: {
          error: (err.message) ? err.message : err
        }
      });

      debug(`Exception Raised -- Purging`);
      process.exit(1);
    })
  });
})
.catch((err) => {
  Raven.captureException('Unable to run script PurgeExpiredAccounts', {
    tags: { script: 'PurgeExpiredAccounts' },
    extra: {
      error: (err.message) ? err.message : err
    }
  });

  debug(`Exception Raised -- MongoDB Connect`);
  process.exit(1);
});


const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const moment    = require('moment');
const debug     = require('debug')('odin-portal:model:authip');

/**
 * Schema for Authorised IP addresses
 */
const AuthIPSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },

  ip: {
    type: String,
    default: ''
  },

  last_login: {
    type: Date,
    default: moment().utc()
  },

  last_activity: {
    type: Date,
    default: moment().utc()
  }
}, {
  timestamps: true
});

AuthIPSchema.statics.saveActivity = function(user, ipAddress) {
  let AuthIP = this;
  debug(`SaveActivity [${ipAddress}] - user:${user._id}`);

  return new Promise((resolve, reject) => {

    AuthIP.findOne({ ip: ipAddress, user: user._id })
    .exec((err, authip) => {
      if (err) {
        debug('Unable to save AuthIP');
        console.log(err);
        return reject(err);
      }

      if (!authip) {
        let authData = {
          user:           user._id,
          ip:             ipAddress,
          last_login:     moment().utc(),
          last_activity:  moment().utc()
        };

        let auth = new AuthIP(authData);
        auth.save((err) => {
          if (err) {
            debug(`Notification SAVE Error - ${user._id}`);
            console.log(err);
            return reject(err);
          }

          user.notificationEnabled('email.newlocation')
          .then((enabled) => {
            if (!enabled) {
              return resolve({ status: 'new', auth: auth });
            }
            
            user.notifyNewLogin(ipAddress)
            .then((sent) => {
              debug(`Sent NewIPAddress notification - user:${user._id}`);

              return resolve({ status: 'new', auth: auth });
            })
            .catch((err) => {
              debug(`Unable to send NewIPAddress notification - user:${user._id}`);
              console.log(err);

              return resolve({ status: 'new', auth: auth });
            });
          })
          .catch((err) => {
            debug(`Unable to send NewIPAddress notification - user:${user._id}`);
            console.log(err);
            
            return resolve({ status: 'new', auth: auth });
          });
        });
      }
      else {
        authip.last_activity  = moment().utc();
        authip.last_login     = moment().utc();

        authip.save((err, _auth) => {
          if (err) return reject(err);
          if (!_auth) return reject(new Error('Unable to save updated auth'));
          return resolve({ status: 'existing', auth: _auth });
        });
      }
    });
  });
}

module.exports = mongoose.model('AuthIP', AuthIPSchema);;

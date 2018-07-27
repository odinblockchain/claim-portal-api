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

AuthIPSchema.statics.saveActivity = function(userId, ipAddress) {
  debug(`AuthIP Upsert -- ${userId} ${ipAddress}`)
  let AuthIP = this;

  return new Promise((resolve, reject) => {
    AuthIP.findOneAndUpdate({ ip: ipAddress, user: userId }, {
      $set: {
        ip: ipAddress,
        user: userId,
        last_login: moment().utc(),
        last_activity: moment().utc()
      }
    }, { upsert: true, new: true })
    .exec((err, authIp) => {
      if (err) {
        debug('Unable to save AuthIP');
        console.log(err);
        return reject(err);
      }

      debug(`Saved AuthIP - ${userId} ${ipAddress}`);
      return resolve(authIp);
    });
  });
}

module.exports = mongoose.model('AuthIP', AuthIPSchema);;

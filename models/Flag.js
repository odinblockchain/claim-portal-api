const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const debug     = require('debug')('odin-portal:model:flag');
const moment    = require('moment');

/**
 * Schema for User Identities
 */
const FlagSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  
  // phoneValidation
  type: {
    type: String,
    default: ''
  },

  // reason for flag
  reason: {
    type: String,
    default: ''
  },

  // any extra data
  extra: {
    type: Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

FlagSchema.statics.FindByUser = function(user) {
  debug(`Pulling Flags - user:${user.claimId}`);

  let Flag = this;
  return new Promise((resolve, reject) => {

    Flag.find({ user: user.claimId })
    .sort({ createdAt: -1 })
    .exec((err, flags) => {
      if (err) return reject(err);
      debug(`-- Found [${flags.length}] Flags - user:${user.claimId}`);
      
      if (!flags.length) return resolve(flags);

      flags = flags.map(f => {
        return {
          id:     f._id,
          type:   f.type,
          reason: f.reason,
          date:   moment(f.createdAt).format('YYYY-MM-DD HH:mm:ss')
        }
      });
      
      return resolve(flags);
    });
  });
};

FlagSchema.statics.findFlags = function(userId, type) {
  debug(`Searching For Flags - user:${userId}, type:${type}`);

  let Flag = this;
  return new Promise((resolve, reject) => {

    let opts = { user: userId };
    if (type) opts['type'] = type;

    Flag.find(opts)
    .exec((err, flags) => {
      if (err) return reject(err);
      debug(`Found [${type}] ${flags.length} flags for user:${userId}`);

      return resolve(flags);
    });
  });
};

FlagSchema.statics.addFlag = function(userId, type, reason, extra) {
  debug(`Flagging action - user:${userId}`);

  let Flag = this;
  return new Promise((resolve, reject) => {
    let flag = new Flag({
      user:   userId,
      type:   type,
      reason: reason,
      extra:  extra || {}
    });

    debug('Flag', JSON.stringify(flag));

    flag.save((err) => {
      if (err) {
        debug(`Flag Save Error - user:${userId}`);
        console.log(err);
        return reject(err);
      }

      resolve(flag);
    });
  });
};

module.exports = mongoose.model('Flag', FlagSchema);

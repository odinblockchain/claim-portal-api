const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const debug     = require('debug')('odin-portal:model:push');
const moment    = require('moment');
const Raven     = require('raven');

/**
 * Schema for Push Notifications (SMS)
 */
const PushSchema = new Schema({

  user: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },

  from: {
    type: String,
    default: ''
  },

  message: {
    type: String,
    default: ''
  },

  failed: {
    type: Boolean,
    default: false
  },

  requested_timestamp: {
    type: Number,
    default: 0
  },

  sent_timestamp: {
    type: Number,
    default: 0
  }
});

PushSchema.set('toJSON', {
  getters: true,
  transform: (doc, ret, options) => {
    delete ret['_id'];
    delete ret['__v'];
    delete ret['user'];
    return ret;
  }
});

PushSchema.virtual('requested_formatted').get(function() {
  if (this.requested_timestamp > 0)
    return moment(this.requested_timestamp).format('YYYY-MM-DD HH:mm:ss');
  else
    return 'pending';
});

PushSchema.virtual('sent_formatted').get(function() {
  if (this.sent_timestamp > 0)
    return moment(this.sent_timestamp).format('YYYY-MM-DD HH:mm:ss');
  else if (this.sent_timestamp = -1)
    return 'rejected';
  else
    return 'pending';
});

PushSchema.statics.SendPush = function(user, message) {
  debug(`Creating Push Request
  User:     ${user.claimId}
  Number:   +${user.phoneNumber}
  Message:  ${message}`);

  let Push = this;
  return new Promise((resolve, reject) => {

    let todo = [];
    if (!user.phone_verified) return reject(new Error('phone_not_verified'));

    user.notificationEnabled('sms.myclaim')
    .then((status) => {
      if (!status) return reject(new Error('notification_not_enabled'));

      let push = new Push({
        user: user._id,
        message: message,
        requested_timestamp: moment().utc()
      });

      push.save((err, _p) => {
        if (err) {
          debug(`Unable to save push notification request!
          User:     ${user.claimId}
          Message:  ${message}`);
  
          Raven.captureMessage('Push Notification Request Failure', {
            level: 'error',
            extra: {
              error: err,
              user: user.claimId,
              message: message
            }
          });
  
          return reject(err);
        }
  
        return resolve(push);
      });
    })
    .catch(reject);
  });
}

module.exports = mongoose.model('Push', PushSchema);

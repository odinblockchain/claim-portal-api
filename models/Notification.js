const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const debug     = require('debug')('odin-portal:model:notification');

/**
 * Schema for User Notifications
 */
const NotificationSchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    unique: true
  },

  sms: {
    myclaim: {
      type: Boolean,
      default: false
    }
  },

  email: {
    myclaim: {
      type: Boolean,
      default: false
    },
    
    loginattempt: {
      type: Boolean,
      default: false
    },

    newlocation: {
      type: Boolean,
      default: false
    },

    claimnews: {
      type: Boolean,
      default: false
    }
  }
}, { timestamps: false });

NotificationSchema.statics.fetchUserNotifications = function(user) {
  debug('Fetching notifications for User');

  let Notification = this;
  return new Promise((resolve, reject) => {
    Notification.findOne({ user: user._id })
    .populate('user')
    .exec((err, notifications) => {
      if (err) {
        debug(`Notification Error - ${user._id}`);
        console.log(err);
        return reject(err);
      }

      resolve(notifications);
    })
  });
}

NotificationSchema.statics.setUserNotification = function(user, key, preference) {
  debug(`Setting notification for User -- [${key}][${preference}] user:${user._id}`);

  let Notification = this;
  return new Promise((resolve, reject) => {
    let notificationData = {};

    Notification.fetchUserNotifications(user)
    .then((UserNotification) => {

      if (!UserNotification) {
        let notificationData = {
          user: user._id
        };

        if (key === 'sms.myclaim')              notificationData.sms = { myclaim: preference };
        else if (key === 'email.myclaim')       notificationData.email = { myclaim: preference };
        else if (key === 'email.loginattempt')  notificationData.email = { loginattempt: preference };
        else if (key === 'email.newlocation')   notificationData.email = { newlocation: preference };
        else if (key === 'email.claimnews')     notificationData.email = { claimnews: preference };

        let notification = new Notification(notificationData);
        notification.save((err) => {
          if (err) {
            debug(`Notification SAVE Error - ${user._id}`);
            console.log(err);
            return reject(err);
          }
    
          resolve(notification);
        });
      }
      else {
        if (key === 'sms.myclaim')              UserNotification.sms.myclaim = preference;
        else if (key === 'email.myclaim')       UserNotification.email.myclaim = preference;
        else if (key === 'email.loginattempt')  UserNotification.email.loginattempt = preference;
        else if (key === 'email.newlocation')   UserNotification.email.newlocation = preference;
        else if (key === 'email.claimnews')     UserNotification.email.claimnews = preference;

        UserNotification.save((err, _preferences) => {
          if (err) return reject(err);
          if (!_preferences) return reject(new Error('Unable to save updated user notifications'));
          return resolve(_preferences);
        });
      }
    });
  });
}

// Remove password for toJSON to protect accidental password leaks
NotificationSchema.set('toJSON', {
  getters: true,
  transform: (doc, ret, options) => {
    delete ret.user;
    delete ret.id;
    delete ret['_id'];
    delete ret['__v'];
    return ret;
  }
});

module.exports = mongoose.model('Notification', NotificationSchema);

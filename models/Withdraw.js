const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const debug     = require('debug')('odin-portal:model:withdraw');
const moment    = require('moment');
const Raven     = require('raven');

/**
 * Schema for User Withdraws
 */
const WithdrawSchema = new Schema({

  user: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },

  rejected: {
    type: Boolean,
    default: false
  },

  tx: {
    type: String,
    default: ''
  },

  from: {
    type: String,
    default: ''
  },

  to: {
    type: String,
    default: ''
  },

  amount: {
    type: Number,
    default: 0
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

WithdrawSchema.set('toJSON', {
  getters: true,
  transform: (doc, ret, options) => {
    delete ret['_id'];
    delete ret['__v'];
    delete ret['user'];
    return ret;
  }
});

WithdrawSchema.virtual('status').get(function() {
  let withdraw = this;
  if (withdraw.rejected === true) return 'rejected';
  else if (withdraw.tx === '') return 'pending';
  else if (withdraw.tx !== '') return 'accepted';
  else return 'unknown';
});

WithdrawSchema.virtual('requested_formatted').get(function() {
  if (this.requested_timestamp > 0)
    return moment(this.requested_timestamp).format('YYYY-MM-DD HH:mm:ss');
  else
    return 'pending';
});

WithdrawSchema.virtual('sent_formatted').get(function() {
  if (this.sent_timestamp > 0)
    return moment(this.sent_timestamp).format('YYYY-MM-DD HH:mm:ss');
  else if (this.sent_timestamp === -1)
    return 'rejected';
  else
    return 'pending';
});

WithdrawSchema.statics.RequestWithdraw = function(user, odinAddress, amount) {
  debug(`Creating Withdraw Request
  User:     ${user._id}
  Balance:  ${user.claim_balance}
  Withdraw: ${amount}
  Send To:  ${odinAddress}`);

  let Withdraw = this;
  return new Promise((resolve, reject) => {

    let todo = [];
    if (!user.claim_setup) return reject(new Error('claim_not_setup'));
    if (user.claim_status !== 'approved') return reject(new Error('request_blocked'));
    if (amount > user.claim_balance) return reject(new Error('insufficient_balance'));
    if (amount === user.claim_balance) amount = user.claim_balance - 0.01;

    let withdraw = new Withdraw({
      user:   user._id,
      to:     odinAddress,
      from:   user.claim_address,
      amount: amount,
      requested_timestamp: moment().utc()
    });

    withdraw.save((err, _withdraw) => {
      if (err) {
        debug(`Unable to make withdraw request!
        User:     ${user._id}
        Balance:  ${user.claim_balance}
        Withdraw: ${amount}
        Send To:  ${odinAddress}`);

        Raven.captureMessage('Withdraw Request Failure', {
          level: 'error',
          extra: {
            error: err,
            user: user._id,
            balance: user.claim_balance,
            address: user.claim_address,
            sendTo: odinAddress,
            amount: amount
          }
        });

        return reject(err);
      }

      return resolve(withdraw);
    });
  });
};

WithdrawSchema.statics.FetchWithdrawRequests = function(userId) {
  debug(`Fetching Withdraw Requests
  User: ${userId}`);

  let Withdraw = this;
  return new Promise((resolve, reject) => {

    Withdraw.find({ user: userId })
    .exec((err, withdraws) => {
      if (err) {
        debug(`Unable to fetch withdraw requests!
        User: ${userId}`);

        Raven.captureMessage('Fetch Withdraw Request Failure', {
          level: 'error',
          extra: {
            error: err,
            user: userId
          }
        });

        return reject(err);
      }

      return resolve(withdraws);
    });
  });
};

WithdrawSchema.statics.FindByUser = function(user) {
  debug(`Pulling Withdraws - user:${user.claimId}`);

  let Withdraw = this;
  return new Promise((resolve, reject) => {

    Withdraw.find({ user: user.claimId })
    .sort({ requested_timestamp: -1 })
    .exec((err, withdraws) => {
      if (err) return reject(err);
      debug(`-- Found [${withdraws.length}] Withdraws - user:${user.claimId}`);
      
      if (!withdraws.length) return resolve(withdraws);

      withdraws = withdraws.map(w => {
        return {
          id:         w._id,
          amount:     w.amount,
          to:         w.to,
          timestamp:  w.sent_timestamp,
          date:       moment(w.sent_timestamp).format('YYYY-MM-DD HH:mm:ss'),
          txid:       w.tx,
          rejected:   w.rejected
        }
      });
      
      return resolve(withdraws);
    });
  });
};

module.exports = mongoose.model('Withdraw', WithdrawSchema);

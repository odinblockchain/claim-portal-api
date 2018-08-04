const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const moment    = require('moment');

/**
 * Schema for User Identities
 */
const PurgedUserSchema = new Schema({

  // system | manual
  type: {
    type: String,
    default: 'system'
  },

  email: {
    type: String,
    default: ''
  },

  wallet: {
    type: String,
    default: ''
  },

  account_created: {
    type: Number
  },

  auth_ips: {
    type: [String],
    default: undefined
  },

  purged_at: {
    type: Number,
    default: () => moment().utc()
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('PurgedUser', PurgedUserSchema);

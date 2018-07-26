const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;

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
    default: Date.now
  },

  last_activity: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('AuthIP', AuthIPSchema);;

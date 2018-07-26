const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const moment    = require('moment');
const uuid      = require('../../lib/uuid');
const AuthIP    = require('../AuthIP');

/**
 * Schema for Policy Acceptances
 */
const PolicyAcceptance = new Schema({
  policyName: {
    type: String, default: 'policy', required: true
  },
  dateAccepted: {
    type: Number, default: -1, required: true
  },
  policyVersion: {
    type: String, default: '0.0', required: true
  },
  accepted: {
    type: Boolean, default: false, required: true
  }
});

/**
 * Schema for User Accounts
 */
const UserSchema = new Schema({
  
  // Unique ID for user account (different from mongoose internal '_id')
  id: {
    type: String, unique: true, index: true, default: uuid.generate()
  },

  // Access level for user account USER | MOD | ADMIN
  level: {
    type: String, default: 'user'
  },

  // Timestamp of request start
  created_at: {
    type: Number, default: moment().utc()
  },

  // Timestamp of any updates done to account
  updated_at: {
    type: Number, default: 0
  },
  
  /**
   * User Details
   */

  // Phone number for user (Used for notifications, security)
  phone: {
    type: String, default: ''
  },

  // Email address for user (Used for notifications, login, security)
  email: {
    type: String, required: true, unique: true, index: true, lowercase: true
  },

  // Hashed password for user
  password: {
    type: String, required: true
  },

  // Obsidian Wallet Address
  wallet: {
    type: String, default: ''
  },

  social: {
    discord: { type: String, default: '' },
    reddit: { type: String, default: '' }
  },

  /**
   * 2FA Integration -- TOTP | TFA
   */
  tfa_enabled: {
    type: Boolean, default: false
  },

  tfa_secret: {
    type: String, default: ''
  },

  /**
   * User Verifications
   */
  wallet_verified: {
    type: Boolean, default: false
  },

  email_verified: {
    type: Boolean, default: false
  },

  phone_verified: {
    type: Boolean, default: false
  },

  /**
   * User Acceptances
   */
  termsAccepted: PolicyAcceptance,
  privacyAccepted: PolicyAcceptance

}, { id: false });

module.exports = UserSchema

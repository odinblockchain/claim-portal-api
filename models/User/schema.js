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
  // id: {
  //   type: String, unique: true, index: true, default: uuid.generate()
  // },

  // Access level for user account USER | MOD | ADMIN
  level: {
    type: String, default: 'user'
  },
 
  // Status of their claim (pending|rejected|accepted|verified)
  claim_status: {
    type: String, default: 'pending'
  },

  // Wallet address associated with user
  claim_address: {
    type: String, default: ''
  },

  // Timestamp of request start
  created_at: {
    type: Number,
    default: () => moment().utc()
  },

  // Timestamp of any updates done to account
  updated_at: {
    type: Number, default: 0
  },
  
  /**
   * User Details
   */

  // Phone number for user (Used for notifications, security)
  country_code: {
    type: String, default: ''
  },

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

  balance: {
    type: Number, default: 0
  },

  // Themes for Portal
  /**
   *  Default   -- #e0e0e0
   *  Black     -- #1d2323
   *  Blue      -- #41C0D1
   *  DarkBlue  -- #00A8B6
   *  Orange    -- #DD6B40
   *  Red       -- #CC4F49
   *  Yellow    -- #C4943F
   *  Brown     -- #AD6A39
   */
  theme: {
    type: String, default: 'default'
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
   * User Locked Balance
   */
  balance_locked: {
    type: Boolean, default: false
  },

  balance_locked_timestamp: {
    type: Number, default: 0
  },
  
  balance_locked_sum: {
    type: Number, default: 0
  },

  /**
   * User Acceptances
   */
  termsAccepted: PolicyAcceptance,
  privacyAccepted: PolicyAcceptance

}, { id: false });

module.exports = UserSchema

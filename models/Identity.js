const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const moment    = require('moment');
const settings  = require('../config/');
const crypto    = require('crypto');
const uuid      = require('../lib/uuid');
const debug     = require('debug')('odin-portal:model:identity');

/**
 * Schema for User Identities
 */
const IdentitySchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },

  // (pending|invalid|accepted)
  identity_status: {
    type: String,
    default: 'pending'
  },

  remarks: {
    type: String,
    default: ''
  },
  
  reference_id: {
    type: String,
    default: ''
  },

  reference_secret: {
    type: String,
    default: ''
  },

  notified: {
    type: Boolean,
    default: false
  },

  created_at: {
    type: Number,
    default: () => moment().utc()
  },

  updated_at: {
    type: Number,
    default: 0
  }
});

IdentitySchema.virtual('signature').get(function() {
  let identityId      = settings['integrations']['shuftipro']['client_key'];
  let identitySecret  = settings['integrations']['shuftipro']['secret_key'];
  let rawSignature    = `${identityId}${this.reference_id}${identitySecret}`;

  return crypto.createHash('sha256').update(rawSignature, 'utf8').digest("hex");
});

IdentitySchema.statics.CreateUniqueId = function() {
  return uuid.generate();
};

/**
 * rawData is hashed using SHA256 and then returned as a HEX signature for Shufti Pro verifications
 * @param {Object} rawData
 */
IdentitySchema.statics.SHA256Sign = (rawData, unique) => {
  if (unique) rawData = rawData + settings['secret'];
  return crypto.createHash('sha256').update(rawData, 'utf8').digest("hex");
};

IdentitySchema.statics.HashSign = (rawData) => {
  if (!rawData) rawData = moment().utc();

  debug(`hashsign :: ${rawData}`);
  return crypto.createHash('sha256').update(rawData).digest('base64');
};

IdentitySchema.statics.ValidateSignature = (requestResponse) => {
  let Identity    = mongoose.model('Identity');
  let rSignature  = Identity.SHA256Sign(
    requestResponse.status_code +
    requestResponse.message +
    requestResponse.reference +
    settings.integrations.shuftipro['secret_key']);

  return !!(rSignature === requestResponse.signature);
};

IdentitySchema.statics.FindByUser = (user) => {
  debug(`Fetching Identities - user:${user.claimId}`);

  let Identity = mongoose.model('Identity');

  return new Promise((resolve, reject) => {

    Identity.find({ user: user._id })
    .sort({ created_at: -1 })
    .exec((err, matchedIdentities) => {
      if (err) {
        console.log(`Unable to pull identities for user - ${user.claimId}`);
        return reject(err);
      }

      if (matchedIdentities.length > 0) {
        matchedIdentities = matchedIdentities.map(i => {
          return {
            identity_status: i.identity_status,
            created_at: i.created_at,
            updated_at: i.updated_at
          }
        });

        return resolve(matchedIdentities);
      }
      else {
        return resolve(matchedIdentities);
      }
    });
  });
}


module.exports = mongoose.model('Identity', IdentitySchema);

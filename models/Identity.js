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

  // (pending|invalid|declined|accepted)
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


IdentitySchema.statics.FindByUser = function(user) {
  debug(`Pulling Identities - user:${user.claimId}`);

  let Identity = this;
  return new Promise((resolve, reject) => {

    Identity.find({ user: user.claimId })
    .exec((err, identities) => {
      if (err) return reject(err);
      debug(`-- Found [${identities.length}] Identities - user:${user.claimId}`);
      
      if (!identities.length) return resolve(identities);

      identities = identities.map(i => {
        return {
          id:         i._id,
          reference:  i.reference_id,
          status:     i.identity_status,
          remarks:    i.remarks,
          created:    moment(i.created_at).format('YYYY-MM-DD HH:mm:ss'),
          updated:    moment(i.updated_at).format('YYYY-MM-DD HH:mm:ss')
        }
      });
      
      return resolve(identities);
    });
  });
};

IdentitySchema.statics.UpdateStatus = function(reference, status) {
  debug(`Updating Identity - reference:${reference}`);

  let Identity = this;
  return new Promise((resolve, reject) => {

    Identity.findOne({ reference_id: reference })
    .exec((err, identity) => {
      if (err) return reject(err);
      if (!identity) return reject(new Error('identity_not_found'));
      if (!/pending|invalid|declined|accepted|skip/.test(status)) return reject(new Error('invalid_status'));

      identity.identity_status = status;
      identity.save((err, _i) => {
        if (err) return reject(err);
        return resolve(_i);
      });
    });
  });
};


module.exports = mongoose.model('Identity', IdentitySchema);

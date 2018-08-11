const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const debug     = require('debug')('odin-portal:model:request');

/**
 * Schema for User Identities
 */
const RequestSchema = new Schema({
  user: { type: Schema.Types.ObjectId, ref: 'User' },
  
  // passwordReset, emailValidation, phoneValidation, tfaValidation (2FA)
  type: {
    type: String,
    default: ''
  },
  
  code: {
    type: String,
    default: ''
  }
}, { timestamps: true });

RequestSchema.statics.create = function(user, type, code) {
  debug('Creating User Request');

  let Request = this;
  return new Promise((resolve, reject) => {

    let request = new Request({
      user: user._id,
      type: type,
      code: code
    });

    debug('request', JSON.stringify(request));

    request.save((err) => {
      if (err) {
        debug(`Request Error - ${user._id}`);
        console.log(err);
        return reject(err);
      }

      resolve(request);
    });
  });
};

RequestSchema.statics.validateWithAuth = function(userId, type, code) {
  debug(`Validating User Request w/AUTH - ${userId} ${type}`);

  let Request = this;
  return new Promise((resolve, reject) => {

    Request
    .findOne({ user: userId, type: type, code: code })
    .populate('user')
    .exec((err, request) => {
      if (err) {
        debug(`Request Validate w/AUTH Error - ${userId} ${type}`);
        console.log(err);
        return reject(err);
      }

      if (!request) {
        debug(`Request Validate w/AUTH Missing - ${userId} ${type}`);
        return reject('request_not_found');
      }
      else {
        debug(`Request Validated w/AUTH - ${userId} ${type}`);
        return resolve(request);
      }
    });
  });
};

RequestSchema.statics.validateWithoutAuth = function(type, code) {
  debug(`Validating User Request wo/AUTH - ${type}`);

  let Request = this;
  return new Promise((resolve, reject) => {

    Request
    .findOne({ type: type, code: code })
    .populate('user')
    .exec((err, request) => {
      if (err) {
        debug(`Request Validate wo/AUTH Error - ${type}`);
        console.log(err);
        return reject(err);
      }

      if (!request) {
        debug(`Request Validate wo/AUTH Missing - ${type}`);
        return reject('request_not_found');
      }
      else {
        debug(`Request Validated wo/AUTH - ${type}`);
        return resolve(request);
      }
    });
  });
};

RequestSchema.statics.removeRequestsByType = function(userId, type) {
  debug(`Removing User Requests - ${userId} ${type}`);

  let Request = this;
  return new Promise((resolve, reject) => {
    Request
    .deleteMany({ user: userId, type: type })
    .exec((err, request) => {
      if (err) {
        debug(`Removing User Requests Error - ${userId} ${type}`);
        console.log(err);
        return reject(err);
      }

      debug(`Removing User Requests Success - ${userId} ${type}`);
      return resolve(true);
    });
  });
};

RequestSchema.statics.getLatestRequestByType = function(userId, type) {
  debug(`Fetching latest request by type - ${userId} ${type}`);

  let Request = this;
  return new Promise((resolve, reject) => {

    Request
    .findOne({ user: userId, type: type })
    .sort({ 'createdAt' : -1 })
    .exec((err, request) => {
      if (err) {
        debug(`Latest Request Fetch Error - ${userId} ${type}`);
        console.log(err);
        return reject(err);
      }

      debug(`Latest Request Fetch Success - ${userId} ${type}`);
      return resolve(request);
    });
  });
}

module.exports = mongoose.model('Request', RequestSchema);

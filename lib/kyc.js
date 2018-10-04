const debug     = require('debug')('odin-portal:lib:kyc');
const settings  = require('../config/');
const https     = require("https");
const qs        = require("querystring");
const crypto    = require('crypto');
const mongoose      = require('mongoose');
const Identity      = mongoose.model('Identity');
const request = require('request');

const KYC_STATUS_CODES = {
  SP0:  'Not Verified',
  SP1:  'Verified',
  SP2:  'Success',
  SP11: 'Parameter Length Validaton',
  SP14: 'Duplicate Reference',
  SP15: 'Invalid CLIENT_ID',
  SP16: 'Missing Parameter',
  SP17: 'Invalid Parameter Format',
  SP18: 'Invalid Signature',
  SP19: 'Invalid Country Code',
  SP20: 'Invalid Phone Number',
  SP21: 'Invalid Verification Method',
  SP22: 'Invalid Checksum',
  SP23: 'Invalid DOB',
  SP24: 'Request Denied; Blocked Client',
  SP25: 'Request Timeout',
  SP26: 'User Verifying',
  SP27: 'Request Repeat',
  SP29: 'Invalid Parameter Size',
  SP32: 'Request Reference Not Found',
  SP33: 'Verification Pending'
};

const DEFAULT_KYC_USER = {
  kyc_id:           '6980XYZ4821XYZ',
  kyc_type:         'passport',
  kyc_first_name:   'John',
  kyc_last_name:    'Doe',
  kyc_birth_day:    1,
  kyc_birth_month:  1,
  kyc_birth_year:   1900,
  kyc_country_code: 'us'
};

/**
 * Makes a POST request to Shufti Pro and streams a Buffer Object response
 * @param {Object} options 
 * @param {Object} post_data 
 */
let shuftiproPost = (options, post_data) => {
  let opts = {
    method:   "POST",
    url: 'https://' + settings.integrations.shuftipro['api_url'],
    headers: {
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: qs.stringify(post_data)
  };

  return new Promise((resolve, reject) => {

    request(opts, (err, resp, body) => {
      console.log('request response');
      if (err) return reject(err);
      console.log(body);
      resolve(body);
    });
    // let apiReq = https.request(options, (res) => {
    //   let chunks = [];
    //   res.on("data", (chunk) => chunks.push(chunk) );
    //   res.on("end", () => resolve(Buffer.concat(chunks)));
    // });

    // debug('Sending POST Request to ShuftiPro');

    // apiReq.write(qs.stringify(post_data))
    // apiReq.end();
  });
};

let validSignature = (requestResponse) => {
  let rSignature = signRequest(requestResponse.status_code + requestResponse.message + requestResponse.reference + settings.integrations.shuftipro['secret_key']);

  return !!(rSignature === requestResponse.signature);
};

/**
 * rawData is hashed using SHA256 and then returned as a HEX signature for Shufti Pro verifications
 * @param {Object} rawData
 */
let signRequest = (rawData) => {
  return crypto.createHash('sha256').update(rawData, 'utf8').digest("hex");
};

module.exports = {
  KYC_STATUS_CODES: KYC_STATUS_CODES,
  DEFAULT_KYC_USER: DEFAULT_KYC_USER,

  
  signRequest: signRequest,
  validSignature: validSignature,
  shuftiproPost: shuftiproPost,

  /**
   * Submit raw form, kyc services, and kyc images to Shufti Pro
   * @param {Object} kyc_data 
   * @param {Object} kyc_services 
   * @param {Object} kyc_images 
   */
  submitKYC: (user, kyc_data, kyc_services, kyc_images) => {
    return new Promise((resolve, reject) => {
      debug(`
      Submit User Identity - user:${user._id}
        Data:     ${JSON.stringify(kyc_data)}
        Services: ${JSON.stringify(kyc_services)}`);

      let identityId = Identity.CreateUniqueId();

      let post_data = {
        'client_id':              settings['integrations']['shuftipro']['client_key'],
        'reference':              identityId,
        'email':                  kyc_data.email,
        'phone_number':           kyc_data.phone_number,
        'country':                (kyc_data.country || 'us').toLowerCase(),
        'lang':                   'en',
        'callback_url':           settings['integrations']['shuftipro']['callback_url'],
        'redirect_url':           settings['integrations']['shuftipro']['callback_url'],
        'verification_services':  JSON.stringify(kyc_services),
        'verification_data':      JSON.stringify(kyc_images)
      };

      let raw_data = '';
      Object.keys(post_data).sort().forEach(function(key) {
        raw_data += post_data[key];
      });

      raw_data += settings['integrations']['shuftipro']['secret_key'];
      post_data["signature"] = Identity.SHA256Sign(raw_data);

      debug(`SIGNATURE: ${post_data["signature"]}`);

      let referenceSig = Identity.HashSign(kyc_services['document_id_no']);
      debug(`UNIQUE SIG: ${referenceSig}`);

      let identity = new Identity({
        user:             user._id,
        reference_id:     identityId,
        reference_secret: referenceSig
      });

      identity.save((err) => {
        if (err) {
          debug(`Identity Save Error`);
          console.log(err);
          Raven.captureMessage('Identity Save Error', {
            level: 'error',
            extra: err
          });
    
          return reject(err);
        }

        debug(`New Identity Saved - user:${user._id} reference:${identityId}`);

        let options = {
          method:   "POST",
          hostname: settings.integrations.shuftipro['api_url'],
          path: "/",
          headers: {
            'content-type': 'application/x-www-form-urlencoded'
          }
        };
  
        shuftiproPost(options, post_data)
        .then((body) => {
          response = JSON.parse(body);
  
          if (Identity.ValidateSignature(response)) {
            debug(`Shuftipro::Signature Accepted - user:${user._id}`);
  
            if (response.status_code === 'SP2' || response.status_code === 'SP1') {
              debug(`Shuftipro::Submission Accepted - user:${user._id}`);
              return resolve({ status: 'ok', kyc_response: response });
            }
            else {
              let rejectReason = (KYC_STATUS_CODES[response.status_code]) ? KYC_STATUS_CODES[response.status_code] : 'unknown';
  
              debug(`Shuftipro::Submission Rejected - user:${user._id}
              REASON  --> ${rejectReason}
              MESSAGE --> ${response.message}`);

              return resolve({ status: 'error', reason: rejectReason });
            }
          }
          else {
            debug(`Shuftipro::Signature Rejected - user:${user._id}`);
            return resolve({ status: 'error', kyc_response: response });
          }
        })
        .catch((err) => {
          reject(err);
        });

      });
    });
  }
}

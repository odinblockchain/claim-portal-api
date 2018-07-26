const debug     = require('debug')('odin-portal:lib:kyc');
const settings  = require('../config/');
const https     = require("https");
const qs        = require("querystring");
const crypto    = require('crypto');

const KYC_STATUS_CODES = {
  SP0: 'Not Verified',
  SP1: 'Verified',
  SP2: 'Success',
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
  return new Promise((resolve, reject) => {
    let apiReq = https.request(options, (res) => {
      let chunks = [];
      res.on("data", (chunk) => chunks.push(chunk) );
      res.on("end", () => resolve(Buffer.concat(chunks)));
    });

    debug('POST to Shufti Pro');

    apiReq.write(qs.stringify(post_data))
    apiReq.end();
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
  submitKYC: (kyc_data, kyc_services, kyc_images) => {
    return new Promise((resolve, reject) => {
      debug('Processing KYC submission');

      let rng = Math.floor(Math.random() * 10000);
      let post_data = {
        'client_id':              settings.integrations.shuftipro['client_key'],
        'reference':              `integration-${rng}`,
        'email':                  `integration-${rng}@site.com`,
        'phone_number':           '+440000000000',
        'country':                (kyc_data['kyc_country_code'] || 'us').toLowerCase(),
        'lang':                   'en',
        'callback_url':           `${settings.integrations.shuftipro['callback_url']}/api/kyc/callback`,
        'redirect_url':           `${settings.integrations.shuftipro]['callback_url']}/api/kyc/redirect`,
        'verification_services':  JSON.stringify(kyc_services),
        'verification_data':      JSON.stringify(kyc_images)
      };

      let raw_data = '';
      Object.keys(post_data).sort().forEach(function(key) {
        raw_data += post_data[key];
      });

      raw_data += settings.integrations.shuftipro['secret_key'];
      post_data["signature"] = signRequest(raw_data);
      
      let options = {
        method: "POST",
        hostname: settings.integrations.shuftipro['api_url'],
        path: "/",
        headers: {
          'content-type': 'application/x-www-form-urlencoded'
        }
      };

      shuftiproPost(options, post_data)
      .then((body) => {
        response = JSON.parse(body);

        debug('shuftiResponse', JSON.stringify(response));

        if (validSignature(response)) {
          debug('shuftipro signature accepted');

          if (response.status_code === 'SP2') {
            debug('shuftipro submission accepted');
          }
          else {
            let rejectReason = (KYC_STATUS_CODES[response.status_code]) ? KYC_STATUS_CODES[response.status_code] : 'unknown';

            debug(`shuftipro submission rejected -- Reason: ${rejectReason} -- Message: ${response.message}`);
          }
          resolve({ status: 'accepted_data', kyc_response: response });
        }
        else {
          console.log('shuftipro rejected, invalid signature');
          resolve({ status: 'rejected_data', kyc_response: response });
        }
      })
      .catch((err) => {
        console.log(err);
        reject(err);
      });
    });
  }
}

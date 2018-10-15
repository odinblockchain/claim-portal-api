const debug     = require('debug')('odin-portal:lib:kyc');
const settings  = require('../config/');
const https     = require("https");
const qs        = require("querystring");
const crypto    = require('crypto');
const mongoose  = require('mongoose');
const Identity  = mongoose.model('Identity');
const request   = require('request');
const Raven     = require('raven');

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
let shuftiproPost = (post_data) => {
  let username = settings['integrations']['shuftipro']['client_id'];
  let password = settings['integrations']['shuftipro']['secret_key'];
  let auth = `Basic ${new Buffer(username + ":" + password).toString("base64")}`;

  let opts = {
    method:   "POST",
    url: settings.integrations.shuftipro['api_url'],
    headers: {
      // 'content-type': 'application/x-www-form-urlencoded',
      'content-type': 'application/json',
      'Authorization': auth
    },
    timeout: (1000 * 120),
    json: true,
    body: post_data
  };

  // console.log(opts);

  return new Promise((resolve, reject) => {

    request(opts, (err, resp, body) => {
      console.log('SHUFTIPRO POST-RESPONSE', body);
      if (err) return reject(err);
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
  submitKYC: (user, kyc_data, kyc_images) => {
    return new Promise((resolve, reject) => {
      debug(`
      Submit User Identity - user:${user._id}
        Data:     ${JSON.stringify(kyc_data)}`);

      let identityId = Identity.CreateUniqueId();

      let shuftipro_post_data = {
        'reference': identityId,
        'callback_url': settings['integrations']['shuftipro']['callback_url'],
        'email': kyc_data.email,
        'country': (kyc_data.country || 'us').toUpperCase(),
        'language': 'EN',
        'verification_mode': 'image_only',
        'face': {
          'proof': ''
        },
        'document': {
          'proof': '',
          'supported_types': [ kyc_data.identity_document_type ], //['passport', 'id_card', 'driving_license'],
          'name': {
            'first_name': kyc_data.first_name,
            'last_name': kyc_data.last_name
          },
          'dob': kyc_data.dob,
          'document_number': kyc_data.identity_document_number
        },
        'address': {
          'proof': '',
          'supported_types': [ kyc_data.address_document_type ], //['id_card', 'utiltiy_bill', 'bank_statement'],
          'full_address': kyc_data.full_address,
          'name': {
            'first_name': kyc_data.first_name,
            'last_name': kyc_data.last_name
          },
        },
        'background_checks': {
          'name': {
            'first_name': kyc_data.first_name,
            'last_name': kyc_data.last_name
          },
          'dob': kyc_data.dob,
        }
      };

      console.log(shuftipro_post_data);
      console.log(JSON.stringify(shuftipro_post_data));

      shuftipro_post_data.face.proof = kyc_images['face_image'];
      shuftipro_post_data.document.proof = kyc_images['document_image'];
      shuftipro_post_data.address.proof = kyc_images['address_image'];

      let referenceSig = Identity.HashSign(kyc_data.identity_document_number);
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
  
        shuftiproPost(shuftipro_post_data)
        .then((body) => {
          let response = {};
          try {
            console.log('TYPEOFBODY', typeof body);
            if (typeof body !== 'object') response = JSON.parse(body);
            else response = body
          } catch(e) {
            debug(`Unable to parse Shuftipro Response
            Error: ${(e.message) ? e.message : e}`);
            Raven.captureMessage('Shuftipro Submission Parse Failed', {
              level: 'error',
              extra: {
                error: e,
                user_id: user._id,
                identity_id: identityId,
                identity_sig: referenceSig,
                responseBody: body
              }
            });

            return reject(e);
          }
          
          if (!response.reference) {
            debug(`Shuftipro::Submission Rejected - user:${user._id}
            Reference MISSING ${JSON.stringify(response)}`);
            return resolve({ status: 'error', reason: 'missing_reference' });
          }

          /**
           * Expecting
           * - reference
           * - event
           * - error
           * - token
           * - verification_result: (result of valid verification)
           *    - 1:    accepted
           *    - 2:    declined
           *    - null: not_processed
           * - verification_data: (only returned in case of a valid verification)
           *    - all gathered data in process
           * 
           * 
           * request.pending
           *  - Request parameters are valid
           * request.invalid
           *  - Request parameters provided in request are invalid
           * verification.accepted
           *  - Request was valid and accepted after verification
           * verification.declined
           *  - Request was valid and declined after verification.
           */
          debug(`Shuftipro::Signature Accepted - user:${user._id}
          Event:      ${response.event}
          Reference:  ${response.reference} `);

          if (/pending|accepted|invalid|declined/ig.test(response.event)) {
            debug(`Shuftipro::Submission Valid Response - user:${user._id}`);
            return resolve(response);
          }
          else {
            console.log(`Shuftipro response ${JSON.stringify(response)}`);
            return reject(new Error('Unable to handle response'));
          }
        })
        .catch((err) => {
          debug(`Unable to submit to Shuftipro
          Error: ${(err.message) ? err.message : err}`);
          Raven.captureMessage('Shuftipro Submission POST Failed', {
            level: 'error',
            extra: {
              error: err,
              user_id: user._id,
              identity_id: identityId,
              identity_sig: referenceSig
            }
          });
          
          reject(err);
        });

      });
    });
  }
}

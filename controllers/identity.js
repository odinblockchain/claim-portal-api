const passport      = require('passport');
const mongoose      = require('mongoose');
const User          = mongoose.model('User');
const debug         = require('debug')('odin-portal:controller:identity');
const AuthIP        = mongoose.model('AuthIP');
const Flag          = mongoose.model('Flag');
const Request       = mongoose.model('Request');
const Notification  = mongoose.model('Notification');
const moment        = require('moment');
const metrics       = require('../lib/metrics');
const Raven         = require('raven');
const Identity      = mongoose.model('Identity');
const settings      = require('../config/');
const kyc           = require('../lib/kyc');
const multer        = require('multer');
const storage       = multer.memoryStorage();
const gm            = require('gm').subClass({ imageMagick: true });

const upload = multer({
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'image/jpeg' || file.mimetype === 'image/jpg' || file.mimetype === 'image/png' || file.mimetype === 'image/pdf') {
      return cb(null, true);
    }
    
    console.log('--KYC Bad File Type', file);
    cb(new Error('reject_identity_file_type'));
  },
  limits: {
    fileSize: (settings['integrations']['shuftipro']['max_upload_size'] * 1000000) // 8MB max limit
  },
  storage: storage
});

let kyc_upload = upload.fields([
  { name: 'kyc_selfie', maxCount: 1 },
  { name: 'kyc_document', maxCount: 1 },
  { name: 'kyc_address', maxCount: 1 }
]);

function parseUserAuthHeader(req) {
  try {
    let authToken = req.headers['authorization'].split(' ');
    let token = authToken[1].split('.')[1];
    let buff = Buffer.from(token, 'base64').toString('binary');
    console.log('BUFF', buff);
    
    return JSON.parse(buff);
  } catch (err) {
    debug('Unable to parseUserAuthHeader');
    console.log(err);
    return '';
  }
}

function escape_string(str) {
  if (str === true || str === 'true') return true;
  else if (str === false || str === 'false') return false;

  return str.replace(/[\0\x08\x09\x1a\n\r"'\\\%]/g, function (char) {
    switch (char) {
      case "\0":
          return "\\0";
      case "\x08":
          return "\\b";
      case "\x09":
          return "\\t";
      case "\x1a":
          return "\\z";
      case "\n":
          return "\\n";
      case "\r":
          return "\\r";
      case "\"":
      case "'":
      case "\\":
      case "%":
          return "\\"+char; // prepends a backslash to backslash, percent,
                            // and double/single quotes
    }
  });
}

/**
 * Convert a buffered image to the base64 equivelent
 * Will reduce filesizes of >= 4MB (4,000,000 "4e6" Bytes)
 * @param {Buffer} imageBuffer 
 */
function bufferToBase64(imageBuffer) {
  return new Promise((resolve, reject) => {
    if (imageBuffer.length >= 4e6) {
      debug('buffered image >= 4 MB (reduce filesize)');
      gm(imageBuffer)
      .quality(30)
      .toBuffer('' , function (err, buffer) {
        if (err) return reject(err);
        let compressed = ((imageBuffer.length - buffer.length) / imageBuffer.length * 100).toFixed(2);
        debug(`buffered image filesize reduction before:${imageBuffer.length} after:${buffer.length} ... saved:${compressed}%`);

        return resolve(buffer.toString('base64'));
      });
    }
    else {
      return resolve(imageBuffer.toString('base64'));
    }
  });
}

module.exports.test = (req, res, next) => {
  res.json({ uuid: Identity.CreateUniqueId() });
};

module.exports.callback = (req, res, next) => {
  debug(`Shuftipro Identity Callback
  Callback Data:
  ${JSON.stringify(req.body)}`);

  Identity.findOne({ reference_id: req.body['reference'] })
  .populate('user')
  .exec((err, identity) => {
    if (!identity || err) {
      if (err) console.log('Shuftipro Identity findOne error', err);
      debug(`Shuftipro Identity Callback - Identity not found: ${req.body['reference']}`);
      return res.send('ok');
    }

    let flagPromises = [];
    if (req.body['event'] === 'verification.accepted') {
      debug('Shuftipro Identity Callback -- ACCEPTED');
      identity['identity_status'] = 'accepted';
    }
    else if (req.body['event'] === 'request.invalid') {
      debug('Shuftipro Identity Callback -- INVALID');
      identity['identity_status'] = 'invalid';
    }
    else if (req.body['event'] === 'verification.declined') {
      debug('Shuftipro Identity Callback -- DECLINED');
      identity['identity_status'] = 'declined';
    }
    else {
      debug('Shuftipro Identity Callback -- PENDING');
      identity['identity_status'] = 'pending';
    }

    identity.user.updateClaimStatus(identity['identity_status'])
    .then(() => {
      identity['updated_at'] = moment().utc();
      identity.save((err, _saved) => {
        if (!err) debug(`Shuftipro Identity Callback - Successful`);
        if (err) {
          debug(`Shuftipro Identity Callback - Error`);
          console.log(err);
          Raven.captureMessage('Identity Update Error', {
            level: 'error',
            body: req.body,
            extra: err
          });
        }

        res.send('ok');
      });
    })
    .catch((err) => {
      debug(`Shuftipro Identity Callback - Error`);
      console.log(err);
      Raven.captureMessage('Identity Flag Add Error', {
        level: 'error',
        body: req.body,
        extra: err
      });

      res.send('ok');
    });
  });
};

module.exports.submitIdentity = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth) return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`Submit User Identity - user:${userId}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) return res.status(401).json({ status: 'error', error: err });
    if (!user) return res.status(401).json({ status: 'error', error: err });

    kyc_upload(req, res, (err_kyc) => {
      if (err_kyc) {
        console.log('ERR OCCURRED', (err_kyc && err_kyc.message) ? err_kyc.message : err_kyc);
        return next(err_kyc);
      }

      debug(`Submit User Identity - user:${userId}
      Request: ${JSON.stringify(req.body)}`);
    
      let idSignature = Identity.HashSign(req.body['kyc_identity_id']);
      console.log('UNIQUE SIGNATURE', idSignature);

      Identity.findOne({ reference_secret: idSignature })
      .populate('user')
      .exec((err, _identity) => {
        if (err) {
          console.log('ERR OCCURRED', (err && err.message) ? err.message : err);
          return next(err);
        }

        if (_identity && _identity.user._id != userId) {
          debug(`Matching Identity Found, Authenticate User Request - user:${userId}`);
          debug(`${_identity.user._id} !== ${userId}`);

          Flag.addFlag(userId, 'identityVerification', 'duplicate_identity', { matched_user: _identity.user._id })
          .then(added => {
            return res.status(400).json({ status: 'error', message: 'duplicate_identity' });
          })
          .catch(error => {
            console.log('Unable to add flag', error);
            return next(error);
          });
        }
        else {
          if (!req.files) return res.status(400).json({ status: 'error', message: 'missing_identity_images' });
          if (!req.files['kyc_document']) return res.status(400).json({ status: 'error', message: 'missing_identity_document' });
          if (!req.files['kyc_selfie']) return res.status(400).json({ status: 'error', message: 'missing_identity_selfie' });
          if (!req.files['kyc_address']) return res.status(400).json({ status: 'error', message: 'missing_identity_address' });
          
          debug(`
          Process User Identity - user:${userId}
            User: ${JSON.stringify(req.body)}
            Files:
              Document: ${req.files['kyc_document'][0].originalname} (${req.files['kyc_document'][0].mimetype}) ${req.files['kyc_document'][0].size} bytes
              Selfie:   ${req.files['kyc_selfie'][0].originalname} (${req.files['kyc_selfie'][0].mimetype}) ${req.files['kyc_selfie'][0].size} bytes
              Address:   ${req.files['kyc_address'][0].originalname} (${req.files['kyc_address'][0].mimetype}) ${req.files['kyc_address'][0].size} bytes
          `);
  
          /*
            cleanup kyc document type
  
            Your customer needs to display their Identity Card. It could be government, school and/or university issued ID card. Shufti Pro verifies the validity of such ID card by cross checking the information (customer's name and date of birth) provided in the request with that on the ID card.
          */
          let kyc_identity_type = ((doc_type) => {
            switch(doc_type) {
              case 'passport': return 'passport';
              case 'driving_license': return 'driving_license';
              case 'id': return 'id_card';
              default: return 'id_card';
            }
          })(req.body['kyc_identity_type']);

          let kyc_address_type = ((doc_type) => {
            switch(doc_type) {
              case 'id': return 'id_card';
              case 'bank': return 'bank_statement';
              case 'utility': return 'utility_bill';
              default: return 'id_card';
            }
          })(req.body['kyc_address_type']);

          let kyc_user_details = {
            'first_name':               req.body['kyc_first_name'],
            'last_name':                req.body['kyc_last_name'],
            'full_address':             req.body['kyc_full_address'],
            'email':                    user.email,
            'country':                  req.body['kyc_country_code'],
            'phone_number':             `+${user.phoneNumber}`,
            'dob':                      req.body['kyc_birth_date'], // 'YYYY-MM-DD'
            'address_document_type':    kyc_address_type,
            'identity_document_type':   kyc_identity_type,
            'identity_document_number': req.body['kyc_identity_id']
          };
          
          try {
            if (typeof req.files['kyc_selfie'] === 'undefined') {
              debug('KYC Rejected -- selfie missing');
              return res.status(400).json({ status: 'error', message: 'missing_identity_selfie' });
            }
      
            if (typeof req.files['kyc_document'] === 'undefined') {
              debug('KYC Rejected -- document missing');
              return res.status(400).json({ status: 'error', message: 'missing_identity_document' });
            }

            if (typeof req.files['kyc_address'] === 'undefined') {
              debug('KYC Rejected -- address missing');
              return res.status(400).json({ status: 'error', message: 'missing_identity_address' });
            }
          } catch(e) {
            console.log('Unable to process identity files', e);
            return res.status(500).json({ status: 'error', message: 'unprocessable' });
          }
          
          Promise.all([
            bufferToBase64(req.files['kyc_selfie'][0]['buffer']),
            bufferToBase64(req.files['kyc_document'][0]['buffer']),
            bufferToBase64(req.files['kyc_address'][0]['buffer'])
          ])
          .then(([selfieBase64, documentBase64, addressBase64]) => {
            debug(`User Identity Files Ready - user:${userId}`);
            
            // let selfieSrcBase64   = req.files['kyc_selfie'][0]['buffer'].toString('base64');
            // let documentSrcBase64 = req.files['kyc_document'][0]['buffer'].toString('base64');
  
            let kyc_images = {
              face_image:     selfieBase64,
              document_image: documentBase64,
              address_image:  addressBase64
            };
  
            kyc.submitKYC(user, kyc_user_details, kyc_images)
            .then((response) => {
              if (response.status === 'ok') {
                res.json({
                  status: 'ok',
                  result: response.event
                });
              }
              else {
                res.json({
                  status: 'error',
                  result: response.event
                });
              }
            })
            .catch((err) => {
              console.log(err);
              let errMessage = (err && err.message) ? err.message : err;
  
              res.json({
                status: 'error',
                message: errMessage
              });
            });
          });
        }

        
      });
    });
    
  });
};

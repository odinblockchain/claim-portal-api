const passport  = require('passport');
const mongoose  = require('mongoose');
const User      = mongoose.model('User');
const Request   = mongoose.model('Request');
const debug     = require('debug')('odin-portal:controller:request');
const QRCode    = require('qrcode');
const moment    = require('moment');
const crypto    = require('crypto');

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

function generatePin(max) {
  if (typeof max === 'undefined') max = 4;
  let buff = crypto.randomBytes(8);
  let uint = buff.readUInt32LE(0);
  return (uint + '').substr(0, max);
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

module.exports.createRequestToken = (req, res, next) => {
  let userRequestEmail  = escape_string(req.body.requestUserEmail);
  let userRequestType   = escape_string(req.body.requestType);
  let userRequestExtra  = escape_string(req.body.requestExtra);

  debug(`Creating Request Token - user:${userRequestEmail}
  Email: ${userRequestEmail}
  Type: ${userRequestType}
  Extra: ${userRequestExtra}`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth || !userDetails.exp)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User.findById(userId)
  .exec( (err, user) => {
    if (err) {
      console.log(err);
      return next(err);
    }

    if (user.level !== 'admin') {
      debug('Alert Set REJECTED -- Unauthorised');
      return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });
    }

    let generatedCode = generatePin(6);

    let request = Request({
      user:   user._id,
      code:   generatedCode,
      type:   userRequestType,
      extra:  userRequestExtra
    });

    request.save((err) => {
      if (err) {
        console.log(err);
        return next(err);
      }

      return res.json({ status: 'ok', generated_code: generatedCode });
    });

    // User.findOne({ email: userRequestEmail })
    // .exec((err, requestUser) => {
    //   if (err) {
    //     console.log(err);
    //     return next(err);
    //   }

    //   Request.removeRequestsByType(userRequestEmail._id, userRequestType)
    //   .then((removed) => {
    //     let request = Request({
    //       user: requestUser._id,
    //       code: generatePin(6),
    //       type: userRequestType
    //     });

    //     request.save((err) => {
    //       if (err) {
    //         console.log(err);
    //         return next(err);
    //       }

    //       return res.json({ status: 'ok' });
    //     })
    //   }).catch(next);
    // });
  });
}

module.exports.verifyRequestToken = (req, res, next) => {
  let requestType = escape_string(req.body.requestType);
  let requestCode = escape_string(req.body.requestCode);

  debug(`Verifying Request Token -
  Code: ${requestCode}
  Type: ${requestType}`);

  Request
  .findOne({ type: requestType, code: requestCode })
  .exec((err, request) => {
    if (err) {
      debug(`Request Validate wo/AUTH Error - ${requestType} (${requestCode})`);
      console.log(err);
      return next(err);
    }

    if (!request) {
      debug(`Verify Request Token Missing - ${requestType} (${requestCode})`);
      return res.json({ status: 'error' });
    }
    else {
      debug(`Verify Request Token Valid - ${requestType} (${requestCode})`);
      return res.json({ status: 'ok' });
    }
  });
}

module.exports.resendVerifyEmail = (req, res, next) => {
  debug(`Resend Verify Email`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User
  .findById(userId)
  .exec((err, user) => {
    if (err) {
      let errMsg = (err.message) ? err.message : err;
      debug(`Resend Verify Email Issue - ${errMsg}`);
      return next(err);
    }

    if (!user) {
      debug(`Resend Verify Email - UserNotFound`);
      return res.status(403).json({ status: 'error', message: 'user_not_found' });
    }

    Request.getLatestRequestByType(userId, 'emailValidation')
    .then((request) => {
      let now = moment().utc();
      let minuteDiff = now.diff(request.createdAt, 'minutes');

      debug(`Latest Email Verification Request -- ${minuteDiff} minute(s) ago | user:${userId}`);

      if (minuteDiff >= 5) {
        Request.removeRequestsByType(userId, 'emailValidation')
        .then((removed) => {

          user.requireEmailValidation()
          .then((sendGridResult) => {
            debug('Resent Email Validation');

            return res.json({ status: 'ok' });
          })
          .catch(next);
        })
        .catch(next);
      }
      else {
        return res.json({ status: 'error', error: 'resend_buffer' });
      }
    });
  });
};


/**
 * Phone Verification Routes
 */
module.exports.createSMSRequest = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  debug(`Request Create SMS Code -- user:${userId}`);

  Request.getLatestRequestByType(userId, 'phoneValidation')
  .then((request) => {
    // console.log('request?', request);
    let now, requestTime;

    if (request) {
      now = moment().utc();
      requestTime = moment(request.createdAt);
      requestTime.add(3, 'minutes');

      let minuteDiff = now.diff(request.createdAt, 'minutes');
      
      debug(`Request SMS Code exists -- ${minuteDiff} minutes old`);

      if (minuteDiff < 3)
        return res.json({
          status:       'error',
          timeDelay:    (3 - minuteDiff),
          unixCreated:  now.unix(),
          unixExpires:  requestTime.unix()
        });
    }

    User
    .findById(userId)
    .exec((err, user) => {
      user.setPhone(req.body.countryCode, req.body.phoneNumber)
      .then((updatedUser) => {
        debug(`Phone set! ${updatedUser.phoneNumber} ... ${updatedUser.country_code} ${updatedUser.phone}`);

        updatedUser.sendSMSAuth()
        .then((pin) => {
          debug(`Sent Pin!`);
          now = moment().utc();
          requestTime = moment().utc();
          requestTime.add(3, 'minutes');
          
          res.json({
            status:       'ok',
            timeDelay:    3,
            unixCreated:  now.unix(),
            unixExpires:  requestTime.unix()
          });
        })
        .catch(next);
      })
      .catch((err) => {
        if (err === 'duplicate_phone' || err === 'blocked_number' || err === 'max_attempts')
          res.json({ status: 'error', message: err });
        else
          next(err);
      });
    });
    // res.json({ status: 'ok', userId: userId });
  });
}

module.exports.verifySMSRequest = (req, res, next) => {
  debug(`Request Verify SMS Code -- ${req.body.code}`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let jwtExp = (userDetails.exp || 0);

  User
  .findById(userId)
  .exec((err, user) => {
    user.verifySMSAuth(req.body.pin)
    .then((_user) => {

      let token = _user.generateJwt(jwtExp);
      return res.json({ status: 'ok', token: token });
    })
    .catch((err) => {
      if (err === 'request_not_found' || err === 'invalid_pin' || err === 'max_attempts')
        return res.json({ status: 'error', message: err });
      else
        return next(err);
    })
  });
}


/**
 * Email Verification Routes
 */

module.exports.verifyEmailCode = (req, res) => {
  debug(`Request Verify Email Code -- ${req.body.code}`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User
  .findById(userId)
  .exec((err, user) => {
    if (err) {
      let errMsg = (err.message) ? err.message : err;
      debug(`Request Verify Email Code Issue - ${req.body.code} - ${errMsg}`);
      console.log(err);

      return res.json({ status: 'error', message: errMsg });
    }

    if (!user) {
      debug(`Request Verify Email Code UserNotFound - ${req.body.code}`);
      return res.status(403).json({ status: 'error', message: 'user_not_found' });
    }

    Request.validateWithAuth(userId, req.body.type, req.body.code)
    .then((request) => {
      Promise.all([ request.user.validateEmail(), Request.removeRequestsByType(userId, req.body.type) ])
      .then( ([ updatedUser, emailRequestsRemoved ]) => {
        
        updatedUser.refreshBalance()
        .then((_userRefresh) => {
          let token = _userRefresh.generateJwt();
          return res.json({ status: 'ok', token: token });
        });
        
      }, (err) => {
        let errMsg = (err.message) ? err.message : err;
        debug(`Request Verify Email Code Failed - ${userId} ${req.body.code}\nReason: ${errMsg}`);
        console.log(err);
        return res.json({ status: 'error', message: errMsg });
      });
    })
    .catch((err) => {
      let errMsg = (err.message) ? err.message : err;
      debug(`Request Verify Email Code Issue - ${req.body.code} - ${errMsg}`);
      console.log(err);

      return res.json({ status: 'error', message: errMsg });
    });
  });
};

module.exports.verifyEmailHex = (req, res) => {
  debug(`Request Verify Email Hex -- ${req.body.code}`);
  
  Request.validateWithoutAuth(req.body.type, req.body.code)
  .then((request) => {
    let user = request.user;

    Promise.all([ request.user.validateEmail(), Request.removeRequestsByType(user._id, req.body.type) ])
    .then( ([ updatedUser, emailRequestsRemoved ]) => {

      updatedUser.refreshBalance()
      .then((_userRefresh) => {
        let token = _userRefresh.generateJwt();
        return res.json({ status: 'ok', token: token });
      });

    }, (err) => {
      let errMsg = (err.message) ? err.message : err;
      debug(`Request Verify Email Hex Failed - ${user._id} ${req.body.code}\nReason: ${errMsg}`);
      console.log(err);

      return res.json({ status: 'error', message: errMsg });
    });
  })
  .catch((err) => {
    let errMsg = (err.message) ? err.message : err;
    debug(`Request Verify Email Hex Issue - ${req.body.code} - ${errMsg}`);
    console.log(err);

    return res.json({ status: 'error', message: errMsg });
  });
};


/**
 * Two-Factor Authentication Routes
 */

module.exports.createTFACode = (req, res, next) => {
  debug(`Request 2FA Code`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User
  .findById(userId)
  .exec((err, user) => {
    if (err) return next(err);

    user.setupTFA()
    .then((secret) => {
      QRCode.toDataURL(secret.otpauth_url, (err, data_url) => {
        if (err) return next(err);

        debug(`2FA request and QR created for user:${userId}`);
        return res.json({ status: 'ok', tfa_qr: data_url, tfa_base: secret.base32 });
      });
    })
    .catch((err) => {
      console.log('error', err);
      return next(err);
    });
  });
};

module.exports.verifyTFACode = (req, res, next) => {
  debug(`Verify 2FA Code`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let jwtExp = (userDetails.exp || 0);

  User
  .findById(userId)
  .exec((err, user) => {
    if (err) return next(err);

    user.verifyTFA(req.body.tfaCode)
    .then((_user) => {
      if (!_user) {
        debug(`2FA REJECTED for user:${userId}`);
        return res.json({ status: 'error', message: 'invalid_tfa_code' });
      }

      debug(`2FA ACCEPTED for user:${userId}`);

      let token = _user.generateJwt(jwtExp);
      return res.json({ status: 'ok', token: token });
    })
    .catch((err) => {
      console.log('error');
      console.log(err);
      return next(err);
    });
  });
};


/**
 * Password Reset routes
 */

module.exports.forgotPassword = (req, res, next) => {
  debug('ForgotPassword');

  let email = req.body.email;
  if (email === '' || !email.length) {
    return res.json({ status: 'error', error: 'No email supplied' });
  }

  User.findOne({ email: email })
  .exec((err, user) => {
    if (err) {
      debug('ForgotPassword, Error', (err.message) ? err.message : err);
      return next(err);
    }

    if (user) {
      user.sendResetPasswordEmail(req.ip)
      .then((email) => { return res.json({ status: 'ok' }) })
      .catch((err) => { return next(err) })
    } else {
      debug('User Not Found');
      return res.json({ status: 'ok' });
    }
  })
};

module.exports.forgotPasswordCancel = (req, res, next) => {
  debug('ForgotPassword, Cancel?');

  let forgotPasswordCode = req.query.token;
  Request.deleteMany({ code: forgotPasswordCode, type: 'passwordReset' })
  .exec((err) => {
    if (err) return next(err);

    debug('ForgotPassword, WIPED');
    return res.json({ status: 'ok' });
  });
};


module.exports.resetPasswordAuthenticate = (req, res, next) => {
  debug(`ResetPassword, Authenticate?`);
  let forgotPasswordCode = req.query.token;

  debug(`ResetPassword Query: ${forgotPasswordCode}`);
  Request.findOne({ code: forgotPasswordCode, type: 'passwordReset' })
  .exec((err, request) => {
    if (err) return next(err);

    if (!request) return next(new Error('Forgot Password Request :: Not Found'));
    
    debug('ResetPassword, ALLOW');
    return res.json({ status: 'ok' });
  });
};

// TODO: DRY
module.exports.resetPassword = (req, res, next) => {
  debug('ResetPassword');

  let newPassword = req.body.password;
  let resetToken  = req.body.token;
  let tfaCode     = req.body.tfaCode;
  
  Request.findOne({ code: resetToken, type: 'passwordReset' })
  .populate('user')
  .exec((err, request) => {
    if (err) return next(err);

    if (!request) return next(new Error('Forgot Password Request :: Not Found'));
    if (!request.user) return next(new Error('Forgot Password Request :: Missing User'));

    if (request.user.tfa_enabled) {
      debug(`ResetPassword, 2FA REQUIRED - user:${request.user.email}`);

      if (!tfaCode)
        return res.status(401).json({ status: 'error', tfa_enabled: true });

      request.user.authTFA(tfaCode)
      .then((success) => {
        debug(`ResetPassword, 2FA ACCEPTED - user:${request.user.email}`);

        request.user.password = newPassword;
        request.user.save((err, savedUser) => {
          if (err) {
            let _errs = [];
            if (err.errors) {
              for (let e in err.errors) {
                let errStr = (err.errors[e].message && err.errors[e].message) ? `[${err.errors[e].kind}] ${err.errors[e].message}` : '...';
                _errs.push(errStr);
              }
            }

            return res.json({ status: 'error', errors: err.errors });
          }

          debug(`ResetPassword, Password Updated - user:${savedUser.email}`);

          Request.removeRequestsByType(savedUser._id, 'passwordReset')
          .then((success) => { return res.json({ status: 'ok' }) })
          .catch((err) => { debug(err); return res.json({ status: 'ok' }); });
        });
      })
      .catch((rejected) => {
        debug(`ResetPassword, 2FA REJECTED - user:${request.user.email}`);

        return res.status(401).json({ status: 'error', tfa_enabled: true, tfa_rejected: true });
      });
    } 
    else {
      debug(`ResetPassword - user:${request.user.email}`);

      request.user.password = newPassword;
      request.user.save((err, savedUser) => {
        if (err) {
          let _errs = [];
          if (err.errors) {
            for (let e in err.errors) {
              let errStr = (err.errors[e].message && err.errors[e].message) ? `[${err.errors[e].kind}] ${err.errors[e].message}` : '...';
              _errs.push(errStr);
            }
          }

          return res.json({ status: 'error', errors: err.errors });
        }

        debug(`ResetPassword, Password Updated - user:${savedUser.email}`);

        Request.removeRequestsByType(savedUser._id, 'passwordReset')
        .then((success) => { return res.json({ status: 'ok' }) })
        .catch((err) => { debug(err); return res.json({ status: 'ok' }); });
      });
    }
  });
};

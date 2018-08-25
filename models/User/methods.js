const settings        = require('../../config/');
const debug           = require('debug')('odin-portal:model:user:method');
const bcrypt          = require('bcryptjs');
const crypto          = require("crypto");
const jwt             = require('jsonwebtoken');
const mongoose        = require('mongoose');
const Request         = mongoose.model('Request');
const sgMail          = require('@sendgrid/mail');
const Raven           = require('raven');
const http            = require('request');
const speakeasy       = require('speakeasy');
const moment          = require('moment');
const Nexmo           = require('nexmo');
const BlockedNumbers  = require('../../lib/blockedNumbers');
// const User      = mongoose.model('User');

function generatePin(max) {
  if (typeof max === 'undefined') max = 4;
  let buff = crypto.randomBytes(8);
  let uint = buff.readUInt32LE(0);
  return (uint + '').substr(0, max);
}

module.exports = function(UserSchema) {

  UserSchema.methods.findEmail = function(cb) {
    return this.model('User').find({ email: this.email }, cb);
  };

  UserSchema.methods.accountDetails = function() {
    let user = this;
    return new Promise((resolve, reject) => {
      resolve({
        phone:            user.phone,
        email:            user.email,
        theme:            user.theme,
        createdAt:        user.created_at,
        emailVerified:    user.email_verified,
        termsAccepted:    user.termsAccepted.accepted,
        walletAddress:    user.wallet,
        addressBalance:   user.balance
      })
    });
  };

  /**
   * Make Third-Party API call to refresh/load a user's balance.
   */
  UserSchema.methods.refreshBalance = function() {
    let user = this;
    return new Promise((resolve, reject) => {
      if (user.wallet === '') {
        debug(`Wallet Address missing or invalid, skipping -- ${user._id}`);
        return resolve(user);
      }

      http({ uri: `${settings.balanceApi}/${user.wallet}/balance`, json: true }, (err, response, body) => {
        // debug('Pull Balance', {
        //   error:    (err) ? err.message : '',
        //   response: (response) ? response.statusCode : '',
        //   body:     body
        // });

        if (err) {
          debug('Unable to refresh balance');
          Raven.captureException('Unable to pull address balance', {
            tags: { model: 'User' },
            extra: {
              error: err,
              response: response,
              body: body
            }
          });
          return resolve(user);
        }

        if (body && body.status !== 'ok')
          return resolve(user);

        user.model('User').findOneAndUpdate({ _id: user._id }, {
          $set: {
            balance: body.balance
          }
        }, { new: true })
        .exec((err, _user) => {
          if (err) {
            debug('Unable to save new balance');
            Raven.captureException('Unable to save address balance', {
              tags: { model: 'User' },
              extra: {
                error: err,
                body: body
              }
            });
            return resolve(_user);
          }
    
          debug(`Saved Balance - ${user._id}`);
          return resolve(_user);
        });
      });
    });
  }

  /**
   * Generate a JSON Web Token
   * https://jwt.io/
   * 
   * - Expiration set 3 days ahead
   * - Append Two-Factor Auth details if applicable
   */
  UserSchema.methods.generateJwt = function(exp) {
    let jwtMoment = moment();
    if (exp) {
      jwtMoment = moment((exp * 1000));
      debug(`Refreshing JWT - ${this._id} exp:${exp} date:${jwtMoment}`);
    } else {
      jwtMoment.add(3, 'days');
      debug(`Generating JWT - ${this._id} date:${jwtMoment}`);
    }

    let userInformation = {
      auth:           this._id,
      email:          this.email,
      country_code:   this.country_code,
      phone:          this.phone,
      theme:          this.theme,
      walletAddress:  this.wallet,
      addressBalance: this.balance,
      flags:  {
        email:          this.email_verified,
        phone:          this.phone_verified,
        termsAccepted:  this.termsAccepted.accepted
      },
      tasks: {},
      exp: jwtMoment.unix()
    };

    if (this.tfa_enabled) {
      debug(`2FA Enabled - ${this._id}`);
      userInformation.tfaVerified = true;
    } else {
      debug(`!TASK -- 2FA - ${this._id}`);
      userInformation.tasks.tfa = true;
    }

    if (!this.phone_verified)
      userInformation.tasks.phone = true;

    if (this.level === 'admin') {
      debug(`!LEVEL -- ADMIN - ${this._id}`);
      userInformation.admin = true;
    }

    // console.log('USER', userInformation);
    return jwt.sign(userInformation, settings.secret);
  };

  // TODO: Remove method
  UserSchema.methods.comparePassword = function(candidatePassword, cb) {
    bcrypt.compare(candidatePassword, this.password, function(err, isMatch) {
      if (err) return cb(err);
      cb(null, isMatch);
    });
  };

  /**
   * Validate a password against a User's encrypted password using bcrypt
   * @param {*} candidatePassword 
   */
  UserSchema.methods.validPassword = function(candidatePassword) {
    let user = this;

    return new Promise((resolve, reject) => {
      bcrypt.compare(candidatePassword, user.password, (err, isMatch) => {
        if (err || !isMatch) return reject(err);
        resolve(true);
      });
    });
  };

  /**
   * Generates an Auth Token and sends an email to user to verify their email address
   * Resolves with SendGrid Object Receipt
   * Rejects with a reason (if available)
   */
  UserSchema.methods.requireEmailValidation = function() {
    debug(`Require Email Validation - ${this.email}`);

    let user    = this;
    let emailVerifyHex = crypto.randomBytes(24).toString('hex');
    let emailVerifyPin = generatePin(6);
  
    return new Promise((resolve, reject) => {

      user.invalidateEmail()
      .then(() => {
        
        Request.create(user, 'emailValidation', emailVerifyHex)
        .then((_hexRequest) => {
          debug(`Created EmailValidation Request 1/2 - ${this._id}`);

          Request.create(user, 'emailValidation', emailVerifyPin)
          .then((_pinRequest) => {
            debug(`Created EmailValidation Request 2/2 - ${this._id}`);

            sgMail.setApiKey(settings.integrations.sendgrid.token);
            sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
            let msg = {
              personalizations: [{
                to: [{ email: user.email }],
                subject: 'ODIN Claim Portal - Verify Your Email',
                dynamic_template_data: {
                  verify_email_url: `${settings.appHost}/verifyEmail?token=${emailVerifyHex}`,
                  email_verify_hex: emailVerifyHex,
                  email_verify_pin: emailVerifyPin
                }
              }],
              template_id: 'd-af67374bbf1248dfa5c6cbeafd4e86ff',
              from: {
                name: 'ODIN Claim Portal',
                email: 'do-not-reply@obsidianplatform.com'
              }
            };
      
            debug(`Request Email Validation Sending - ${user.email} [${emailVerifyHex}]`);
      
            sgMail.send(msg)
            .then(resolve)
            .catch((err) => {
              Raven.captureException('Unable to deliver Email Validation', {
                level: 'error',
                extra: {
                  code: (err.code) ? err.code : '',
                  message: (err.message) ? err.message : ''
                }
              });

              reject(err);
            });
          })
          .catch((err) => {
            debug(`Request Email Validation Error 2/2 - ${user.email}`);
            Raven.captureException('Unable to create Email Validation (pin)', {
              level: 'error',
              extra: {
                code: (err.code) ? err.code : '',
                message: (err.message) ? err.message : ''
              }
            });

            reject(err);
          });
        })
        .catch((err) => {
          debug(`Request Email Validation Error 1/2 - ${user.email}`);
          Raven.captureException('Unable to deliver Email Validation (hex)', {
            level: 'error',
            extra: {
              code: (err.code) ? err.code : '',
              message: (err.message) ? err.message : ''
            }
          });

          reject(err);
        });
      })
      .catch();
    });
  };
  
  UserSchema.methods.resetPasswordToken = function() {
    let user = this;
  
    return new Promise((resolve, reject) => {
      user.update({
        $set: {
          password_reset_token: ''
        }
      }, (err, modified) => {
        if (err) return reject(err);
        if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
        debug('user reset password token cleared');
        resolve(true);
      });
    });
  }

  UserSchema.methods.resetTFACode = function() {
    let user = this;
  
    return new Promise((resolve, reject) => {

      user.tfa_enabled = false;
      user.tfa_secret = '';
      user.save((err, _user) => {
        if (err) return reject(err);
        if (!_user) return reject(new Error('Unable to save updated user details'));
        return resolve(_user);
      });
      // user.update({
      //   $set: {
      //     tfa_enabled: false,
      //     tfa_secret: ''
      //   }
      // }, (err, modified) => {
      //   if (err) return reject(err);
      //   if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
      //   debug('reset TFA Code');
      //   resolve(true);
      // });
    });
  }
  
  /**
   * Generates a random HEX code for user to validate a "Reset Password" request.
   * Removes any previous requests for password resetting.
   * @param {string} requestIp 
   */
  UserSchema.methods.sendResetPasswordEmail = function(requestIp) {
    debug(`Send ResetPassword - user:${this.email}`);

    let user      = this;
    let resetHex  = crypto.randomBytes(32).toString('hex');
  
    return new Promise((resolve, reject) => {

      Request.deleteMany({ user: user._id, type: 'passwordReset' })
      .exec((err) => {
        if (err) debug('Request removal error', err);

        Request.create(user, 'passwordReset', resetHex)
        .then((_hexRequest) => {
          debug(`Created ResetPassword Request - user:${this.email}`);

          sgMail.setApiKey(settings.integrations.sendgrid.token);
          sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
          let msg = {
            personalizations: [{
              to: [{ email: user.email }],
              subject: 'ODIN Claim Portal - Reset Acccount Password',
              dynamic_template_data: {
                cancel_reset_request_link: `${settings.appHost}/forgot-password-cancel?token=${resetHex}`,
                request_ip_address: requestIp,
                reset_request_link: `${settings.appHost}/forgot-password-reset?token=${resetHex}`,
              }
            }],
            template_id: 'd-3b286cacdb954a0cb49e2f35101f7f55',
            from: {
              name: 'ODIN Claim Portal',
              email: 'do-not-reply@obsidianplatform.com'
            }
          };
    
          debug(`ResetPassword Email Sending - user:${user.email} [${resetHex}]`);
    
          sgMail.send(msg)
          .then(resolve)
          .catch((err) => {
            Raven.captureException('Unable to deliver ResetPassword email', {
              level: 'error',
              extra: {
                code: (err.code) ? err.code : '',
                message: (err.message) ? err.message : ''
              }
            });

            reject(err);
          });
        })
        .catch((err) => {
          debug(`Request Reset Password Email Failed - user:${user.email}`);
          Raven.captureException('Unable to create Reset Password Request (hex)', {
            level: 'error',
            extra: {
              code: (err.code) ? err.code : '',
              message: (err.message) ? err.message : ''
            }
          });

          reject(err);
        });
      });
    });
  };
  
  /**
   * Setup 2FA for User
   * - Resolves the generated 2FA Secret Object
   * -> { ascii, hex, base32, otpauth_url }
   * 
   * - Rejects with an error reason (if available)
   */
  UserSchema.methods.setupTFA = function() {
    let user = this;
  
    return new Promise((resolve, reject) => {
      debug(`Setup TFA for user:${user._id}`);
  
      let secret = speakeasy.generateSecret({
        name: 'ODIN Claim Portal'
      });
      
      if (!secret || !secret.base32 || !secret.otpauth_url) {
        return reject('generation_failure');
      }

      // debug(secret);
      /**
       * secret = {
       *  ascii
       *  hex
       *  base32
       *  otpauth_url
       * }
       */

      Request.deleteMany({ user: user._id, type: 'tfaValidation' })
      .exec((err) => {
        let request = new Request({
          user: user._id,
          type: 'tfaValidation',
          code: secret.base32
        });

        request.save((err, _req) => {
          if (err) return reject(err);
          resolve(secret);
        });
      });
    });
  }
  
  /**
   * Verify 2FA for User
   * - Resolves TRUE
   * 
   * - Rejects with an error reason (if available)
   */
  UserSchema.methods.verifyTFA = function(tfaCode) {
    let user = this;

    return new Promise((resolve, reject) => {

      Request.findOne({ user: user._id, type: 'tfaValidation' })
      .exec((err, request) => {
        if (err) return reject(err);

        let verified = speakeasy.totp.verify({
          secret:     request.code,
          encoding:   'base32',
          token:      tfaCode
        });

        debug(`Verifying 2FA for user:${user._id} -- ?:${verified}`);

        if (verified) {
          mongoose.model('User').findOneAndUpdate({ _id: user._id }, {
            tfa_enabled: true,
            tfa_secret: request.code
          }, { new: true })
          .exec((err, updatedUser) => {
            if (err) return reject(err);

            Request.deleteMany({ user: updatedUser._id, type: 'tfaValidation' })
            .exec((err) => {
              if (err) debug('Unable to remove TFA Requests');

              return resolve(updatedUser);
            });
          });
        } else{
          return resolve(false);
        }
      });
    });
  }
  
  UserSchema.methods.authTFA = function(tfaCode) {
    let user = this;
    return new Promise((resolve, reject) => {

      let verified = speakeasy.totp.verify({
        secret:     user.tfa_secret,
        encoding:   'base32',
        token:      tfaCode
      });

      debug(`Verifying 2FA for user:${user._id} -- ?:${verified}`);
  
      if (verified) return resolve(true);
      return reject('INVALID');
    });
  }
  
  /**
   * Sends an Email with Auth Token to User
   * - Resolves TRUE
   * 
   * - Rejects with an error reason (if available)
   */
  // UserSchema.methods.sendEmailVerification = function(token) {
  //   let sgMail = require('@sendgrid/mail');
  //   let user = this;
  
  //   sgMail.setApiKey(settings.sendgrid_token);
  //   sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
  //   let msg = {
  //     to:             user.email,
  //     from:           'do-not-reply@loki.chat',
  //     subject:        'ODIN - Verify Your Email',
  //     templateId:     '5cf971ed-5a97-42f2-a697-3cbd68f064fb',
  //     substitutions:  {
  //       verify_email_url: 'http://localhost:3000/verify?token=' + user.email_verification_token
  //     },
  //   };
  
  //   debug(`Sending Email Token To: ${user.email} [${user.email_verification_token}] ??? ${token}`);
  //   // return sgMail.send(msg);
  //   return new Promise((res, rej) => {
  //     res(true);
  //   });
  // };
  
  UserSchema.methods.authWalletRequest = function() {
    let user = this;
    const randomWords = require('random-words');
  
    return new Promise((resolve, reject) => {
      let word  = randomWords();
  
      user.update({
        $set: {
          wallet_verified: false,
          wallet_verification_token: word
        }
      }, (err, modified) => {
        if (err) return reject(err);
        if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
        resolve(word);
      });
    });
  }
  
  UserSchema.methods.authWalletVerify = function(authSignedMessage) {
    let user = this;
    const request = require('request');
  
    return new Promise((resolve, reject) => {
  
      let uri     = `${settings.appHost}/api/blockchain/verifymessage`;
      let params  = {
        address:  user.wallet,
        signed:   authSignedMessage,
        message:  user.wallet_verification_token
      };
  
      debug('Wallet Auth Verify', params);
  
      request({ uri: uri, json: true, qs: params }, (err, response, body) => {
        debug('API', {
          error:    (err) ? err.message : '',
          response: (response) ? response.statusCode : '',
          body:     body
        });
  
        if (err || response.statusCode !== 200) return reject('EAUTH');
        if (body === false) return reject('BAD_SIGNATURE');
        
        user.update({
          $set: {
            wallet_verified: true,
            wallet_verification_token: ''
          }
        }, (err, modified) => {
          if (err) return reject(err);
          if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
          resolve(true);
        });
      });
    });
  }
  
  UserSchema.methods.setPhone = function(countryCode, phoneNumber) {
    let user  = this;
    // let blockedNumbers = settings.integrations.nexmo.blocked_numbers || [];

    debug(`Saving country:${countryCode} phone:${phoneNumber} to user:${user.email}`);

    return new Promise((resolve, reject) => {
      let fullNumber = `${countryCode}${phoneNumber}`;
      debug(`${fullNumber} in ${BlockedNumbers.length}`);
      if (BlockedNumbers.indexOf(fullNumber) !== -1) return reject('blocked_number');

      mongoose.model('User')
      .findOne({ phone: phoneNumber })
      .exec((err, match) => {
        if (err) return reject(err);
        if (match && user.email !== match.email) return reject('duplicate_phone');
        
        mongoose.model('User')
        .findOneAndUpdate({ _id: user._id }, {
          country_code: countryCode,
          phone: phoneNumber,
          phone_verified: false
        }, { new: true })
        .exec((err, updatedUser) => {
          if (err) return reject(err);
  
          resolve(updatedUser);
        });
      });
    })
  }

  UserSchema.methods.sendSMSAuth = function() {
    var nexmo = new Nexmo({
      apiKey:         settings.integrations.nexmo.key,
      apiSecret:      settings.integrations.nexmo.secret
    }, {
      debug: true
    });
  
    let user = this;
  
    return new Promise((resolve, reject) => {    
      const pin   = generatePin(6);
      const from  = '12018903094';
      const to    = user.phoneNumber;
      const text  = `Your ODIN verification code is ${pin}`;

      Request.deleteMany({ user: user._id, type: 'phoneValidation' })
      .exec((err) => {
        if (err) debug('Request removal error', err);

        Request.create(user, 'phoneValidation', pin)
        .then((_pinRequest) => {
          debug(`Created PhoneValidation Request - user:${user.email} phone:${user.phone}`);

          nexmo.message.sendSms(from, to, text, (err, result) => {
            if (err) {
              debug('SMS Auth Request Err', err);
              return reject(err);
            }
      
            debug('SMS Result', result);

            if (result && Number(result.messages[0]['remaining-balance']) <= 3) {
              let balance = Number(result.messages[0]['remaining-balance']);
              debug(`TRIGGER WARNING -- Nexmo Balance LOW ${balance}`);
              Raven.captureMessage('SMS Nexmo Balance Low', {
                level: 'warning',
                logger: 'User.Methods.sendSMSAuth',
                extra: {
                  balance: balance
                }
              });
            }
      
            /**
             *  {
             *    'message-count': '1',
                  messages: [
                    {
                      to: '13125506948',
                      'message-id': '0B000000E170D22C',
                      status: '0',
                      'remaining-balance': '1.95860000',
                      'message-price': '0.00570000',
                      network: '310004'
                    }
                  ]
                }
            */
      
            if (result && result.messages[0].status == '0') {
              user.update({
                $set: {
                  phone_verified: false
                }
              }, (err, modified) => {
                if (err) return reject(err);
                if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
                resolve(pin);
              });
            } else {
              reject(result.error_text ? result.error_text : 'NO_RESPONSE');
            }
          });
        });
      });
    });
  }
  
  UserSchema.methods.verifySMSAuth = function(pin) {
    let user = this;
    pin = `${pin}`;
  
    return new Promise((resolve, reject) => {

      Request.findOne({ user: user._id, type: 'phoneValidation' })
      .exec((err, request) => {
        if (err) return reject(err);

        if (!request) return reject('request_not_found');

        debug(`Verifying SMS Auth for user:${user.email} ... PIN:${pin} Code:${request.code}`);

        if (pin === request.code) {
          mongoose.model('User').findOneAndUpdate({ _id: user._id }, {
            phone_verified: true
          }, { new: true })
          .exec((err, updatedUser) => {
            if (err) return reject(err);

            Request.deleteMany({ user: updatedUser._id, type: 'phoneValidation' })
            .exec((err) => {
              if (err) debug('Unable to remove phoneValidation Requests');
              return resolve(updatedUser);
            });
          });
        }
        else {
          return reject('invalid_pin');
        }
      });
    });
  }
  
  UserSchema.methods.lookupSMSRecord = function() {
    let user = this;
  
    return new Promise((resolve, reject) => {
      var Nexmo = require('nexmo');
      var nexmo = new Nexmo({
        apiKey: settings.integrations.nexmo.key,
        apiSecret: settings.integrations.nexmo.secret,
        applicationId: settings.integrations.nexmo.application_id
      }, {
        debug: true
      });
  
      nexmo.numberInsight.get({
        level: 'standard',
        number: user.phone
      }, (err, record) => {
        if (err) {
          console.log('LOOKUP ERROR');
          debug(err);
          return reject(err);
        }
  
        console.log('LOOKUP OKAY?', record);
        if(record && record.status == '0') {
          resolve(record);
        } else {
          reject(record.error_text ? record.error_text : 'NO_RESPONSE');
        }
      });
    });
  }
  
  /**
   * UK NOTES:
   * Blocked Phone Numbers:
   * Personal Numbers (+4470)
   * Premium Numbers (+449)
   * 
   * US Notes:
   * T-Mobile, Sprint heavily block short code numbers
   * US Short codes CANNOT be used to send SMS to other countries
   * LONG VIRTUAL NUMBER NOTES:
   * MAX 1 SMS per SECOND! (query service probably needed)
   * MAX 500 SMS per long virtual number!
   * SHORT CODE NOTES:
   * NO daily MAX messages per day
   * 30 SMS per SECOND!
   * Dedicated:$1000 (8-12 weeks)
   * Shared:FREE (3-5 biz days)
   * 
   * CANADA NOTES:
   * SMS to CANDA MUST COME from CANADA or USA
   */
  
  UserSchema.methods.requireSMSValidation = function(cb) {
    let user = this;
  
    return new Promise((resolve, reject) => {
      var Nexmo = require('nexmo');
      var nexmo = new Nexmo({
        apiKey: settings.integrations.nexmo.key,
        apiSecret: settings.integrations.nexmo.secret,
        applicationId: settings.integrations.nexmo.application_id
      }, {
        debug: true
      });
  
      debug(`MAKING SMS VERIFY REQUEST TO USER [${user.phone}]`);
  
      nexmo.verify.request({
        number: user.phone,
        brand: "ODIN-PORTAL"
      }, function(err, result) {
        if (err) {
          console.log('SMS ERROR');
          debug(err);
          return reject(err);
        }
  
        console.log('SMS OKAY?', result);
        let requestId = result.request_id;
        if(result && result.status == '0') {
          user.update({
            $set: {
              phone_verified: false,
              phone_verification_token: requestId
            }
          }, (err, modified) => {
            if (err) return reject(err);
            if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
            resolve(requestId);
          });
        } else {
          reject(result.error_text ? result.error_text : 'NO_RESPONSE');
        }
      });
    });
  }
  
  UserSchema.methods.verifySMSValidation = function(smsCode) {
    let user = this;
  
    return new Promise((resolve, reject) => {
      var Nexmo = require('nexmo');
      var nexmo = new Nexmo({
        apiKey: settings.integrations.nexmo.key,
        apiSecret: settings.integrations.nexmo.secret,
        applicationId: settings.integrations.nexmo.application_id
      }, {
        debug: true
      });
  
      debug(`VERIFY SMS VERIFY REQUEST FROM USER [${user.phone}] WITH ID [${user.phone_verification_token}`);
  
      nexmo.verify.check({
        request_id: user.phone_verification_token,
        code: smsCode
      }, function(err, result) {
        if(err) {
          console.log('SMS ERROR');
          debug(err);
          return reject(err);
        } else {
          console.log(result);
          // Error status code: https://docs.nexmo.com/verify/api-reference/api-reference#check
  
          user.update({
            $set: {
              phone_verified: (result && result.status == '0') ? true : false,
              phone_verification_token: ''
            }
          }, (err, modified) => {
            if (err) return reject(err);
            if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
            debug('UPDATED PHONE VERIFICATION STATUS FOR USER')
            if (result && result.status == '0') {
              resolve(true);
            } else {
              reject(result.error_text ? result.error_text : 'NO_RESPONSE');
            }
          });
        }
      });
    });
  }

  /**
   * Methods to VALIDATE User Information
   */
  
  /**
   * Set VALIDATE TRUE for a User's email
   */
  UserSchema.methods.validateEmail = function() {
    debug(`Validating User Email - ${this.id}}`);

    let user = this;
    return new Promise((res, rej) => {
      user.set({ email_verified: true });
      user.save((err, updatedUser) => {
        if (err) return rej(err);
        debug(`User Email Validated - ${updatedUser.id} [${updatedUser.email_verified}]}`);
        res(updatedUser);
      });
      // user.update({
      //   $set: {
      //     email_verified: true
      //   }
      // }, (err, modified) => {
      //   if (err) return rej(err);
      //   if (modified && modified.ok !== 1) return rej('USER_NOT_MODIFIED');
      //   debug(`User Email Validated - ${this.id}}`);
      //   res(true);
      // });
    });
  }

  /**
   * Methods to invalidate User Information
   */
  
  
  /**
   * Invalidate a user's wallet
   */
  UserSchema.methods.invalidateWallet = function() {
    let user = this;
    return new Promise((res, rej) => {
      user.update({
        $set: {
          wallet_verified: false
        }
      }, (err, modified) => {
        if (err) return rej(err);
        if (modified && modified.ok !== 1) return rej('NOT_MODIFIED');
        res(true);
      });
    });
  }
  
  /**
   * Invalidate a user's email address
   */
  UserSchema.methods.invalidateEmail = function() {
    debug(`Invalidating User Email - ${this._id}`);

    let user = this;
    return new Promise((res, rej) => {
      user.update({
        $set: {
          email_verified: false
        }
      }, (err, modified) => {
        if (err) return rej(err);
        if (modified && modified.ok !== 1) return rej('NOT_MODIFIED');
        debug(`User Email Invalidated - ${this._id}}`);
        res(true);
      });
    });
  }
  
  /**
   * Invalidate a user's phone number (SMS)
   */
  UserSchema.methods.invalidatePhone = function() {
    let user = this;
    console.log('invalidate phone?');
    return new Promise((res, rej) => {
      user.update({
        $set: {
          phone_verified: false
        }
      }, (err, modified) => {
        console.log('done');
        if (err) return rej(err);
        if (modified && modified.ok !== 1) return rej('NOT_MODIFIED');
        res(true);
      });
    });
  }
}

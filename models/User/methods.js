const settings  = require('../../config/');
const debug     = require('debug')('odin-portal:model:user:method');
const bcrypt    = require('bcryptjs');
const crypto    = require("crypto");
const jwt       = require('jsonwebtoken');
const mongoose  = require('mongoose');
const Request   = mongoose.model('Request');
const sgMail = require('@sendgrid/mail');

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
        createdAt:        user.created_at,
        emailVerified:    user.email_verified,
        privacyAccepted:  user.privacyAccepted.accepted,
        termsAccepted:    user.termsAccepted.accepted,
        walletAddress:    user.wallet
      })
    });
  };

  /**
   * Generate a JSON Web Token
   * https://jwt.io/
   * 
   * - Expiration set 7 days ahead
   * - Append Two-Factor Auth details if applicable
   */
  UserSchema.methods.generateJwt = function() {
    debug(`Generating JWT - ${this._id}`);

    let expiry = new Date();
    expiry.setDate(expiry.getDate() + 7);
    
    let userInformation = {
      auth:   this._id,
      email:  this.email,
      flags:  {
        email: this.email_verified
      },
      exp:    parseInt(expiry.getTime() / 1000)
    };

    if (this.tfa_enabled) {
      debug(`TFA Enabled - ${this._id}`);
      userInformation.tfaVerified = false;
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
            .catch(reject);
          })
          .catch((err) => {
            debug(`Request Email Validation Error 2/2 - ${user.email}`);
            reject(err);
          });
        })
        .catch((err) => {
          debug(`Request Email Validation Error 1/2 - ${user.email}`);
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
  
  UserSchema.methods.sendPasswordResetEmail = function(resetToken, requestIp) {
    let crypto  = require('crypto');
    let user    = this;
  
    return new Promise((resolve, reject) => {
      if (resetToken === '') {
        debug('resetToken is empty for user, aborting');
        return reject('missing_token');
      }
  
      debug(`Sending Password Reset Email To: ${user.email} [${resetToken}]`);
  
      sgMail.setApiKey(settings.integrations.sendgrid.token);
      sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
      let msg = {
        to:             user.email,
        from:           'do-not-reply@loki.chat',
        subject:        'ODIN - Password Reset Request',
        templateId:     '8468c0b3-252d-48aa-8876-001f1ae3ebe0',
        substitutions:  {
          request_ip_address:         (requestIp) ? requestIp : '',
          reset_password_url:         `${settings.appHost}/reset-password-auth?auth=${resetToken}`,
          cancel_password_reset_url:  `${settings.appHost}/reset-password-cancel?auth=${resetToken}`,
        }
      };
    
      sgMail.send(msg)
      .then(resolve)
      .catch(reject);
    });
  };
  
  /**
   * Setup 2FA for User
   * - Resolves the generated 2FA Secret Object
   * -> { ascii, hex, base32, otpauth_url }
   * 
   * - Rejects with an error reason (if available)
   */
  UserSchema.methods.setupXFA = function() {
    let user = this;
    let speakeasy = require('speakeasy');
  
    return new Promise((resolve, reject) => {
      debug(`SETTING UP 2FA`);
  
      var secret = speakeasy.generateSecret({
        name: 'ODIN Portal'
      });
      
      if (!secret || !secret.base32 || !secret.otpauth_url) {
        return reject('MISSING_SECRETS');
      }
  
      debug(secret);
  
      user.update({
        $set: {
          xfa_enabled:      false,
          xfa_secret:       '',
          xfa_secret_tmp:   secret.base32
        }
      }, (err, modified) => {
        if (err) return reject(err);
        if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
  
        resolve(secret);
      });
    });
  }
  
  /**
   * Verify 2FA for User
   * - Resolves TRUE
   * 
   * - Rejects with an error reason (if available)
   */
  UserSchema.methods.verifyXFA = function(xfaToken) {
    let user = this;
    return new Promise((resolve, reject) => {
      let speakeasy = require('speakeasy');
  
      debug(`VALIDATING 2FA`, {
        secret: user.xfa_secret_tmp,
        token:  xfaToken
      });
  
      var verified = speakeasy.totp.verify({
        secret:     user.xfa_secret_tmp,
        encoding:   'base32',
        token:      xfaToken
      });
      
      user.update({
        $set: {
          xfa_enabled:      verified,
          xfa_secret:       (verified) ? user.xfa_secret_tmp : '',
          xfa_secret_tmp:   (verified) ? '' : user.xfa_secret_tmp,
        }
      }, (err, modified) => {
        if (err) return reject(err);
        if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
  
        if (verified) return resolve(true);
        return reject('INVALID');
      });
    });
  }
  
  UserSchema.methods.authXFA = function(xfaToken) {
    let user = this;
    return new Promise((resolve, reject) => {
      let speakeasy = require('speakeasy');
  
      debug(`VALIDATING 2FA`, {
        secret: user.xfa_secret,
        token:  xfaToken
      });
  
      var verified = speakeasy.totp.verify({
        secret:     user.xfa_secret,
        encoding:   'base32',
        token:      xfaToken
      });
  
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
  
  UserSchema.methods.sendSMSAuth = function() {
    let Nexmo = require('nexmo');
    var nexmo = new Nexmo({
      apiKey:         settings.integrations.nexmo.key,
      apiSecret:      settings.integrations.nexmo.secret
    }, {
      debug: true
    });
  
    let user = this;
  
    return new Promise((resolve, reject) => {    
      const pin   = generatePin();
      const from  = '12018903094';
      const to    = user.phone;
      const text  = `Your ODIN verification code is ${pin}`;
      
      nexmo.message.sendSms(from, to, text, (err, result) => {
        if (err) {
          debug('SMS Auth Request Err', err);
          return reject(err);
        }
  
        debug('SMS Result', result);
  
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
  
        if(result && result.messages[0].status == '0') {
          user.update({
            $set: {
              phone_verified: false,
              phone_verification_token: pin + ''
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
  }
  
  UserSchema.methods.verifySMSAuth = function(pin) {
    let user = this;
    pin = pin + '';
  
    return new Promise((resolve, reject) => {
  
      const sent_pin = user.phone_verification_token + '';
      if (sent_pin === '') {
        return reject('NO_PIN_SENT');
      }
  
      debug(`VERIFYING SMS AUTH ... USER: [${pin}] SYS: [${sent_pin}]`);
  
      const valid_auth = !!(sent_pin === pin);
  
      debug(`VALID? ... ${valid_auth}`);
  
      user.update({
        $set: {
          phone_verified: valid_auth,
          phone_verification_token: ''
        }
      }, (err, modified) => {
        if (err) return reject(err);
        if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
        debug('UPDATED PHONE VERIFICATION STATUS FOR USER');
  
        resolve(valid_auth);
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

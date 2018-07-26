const settings  = require('../../config/');
const debug     = require('debug')('odin-portal:model:user');
const request = require('request');

function validEmail(email) {
  var emailRegex1 = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  var emailRegex2 = /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;

  return emailRegex2.test(email);
};

module.exports = function(UserSchema) {
  console.log('USER', typeof UserSchema);

  UserSchema.statics.sample = function(foo) {
    let User = this;
    return 'ODIN' + foo;
  }

  UserSchema.statics.validateSignature = function(address, signature, word) {
    return new Promise((resolve, reject) => {
  
      let uri     = `${settings.apiHost}/api/blockchain/verifymessage`;
      let params  = {
        address:  address,
        signed:   signature,
        message:  word
      };
  
      debug('Wallet Auth Verify', params);
  
      request({ uri: uri, json: true, qs: params }, (err, response, body) => {
        debug('API', {
          error:    (err) ? err.message : '',
          response: (response) ? response.statusCode : '',
          body:     body
        });

        if (typeof body === 'string' && body.match(/invalid address/ig)) return reject('BAD_ADDRESS');
        if (err || response.statusCode !== 200) return reject('EAUTH');
        if (body === false) return reject('BAD_SIGNATURE');
        if (body === true) return resolve(true);
      });
    });
  }

  /**
   * Searches for a User with a matching token and verify the email address associated to them
   * @param {String} token 
   */
  UserSchema.statics.verifyEmail = function(token) {
    let User = this;
    return new Promise((resolve, reject) => {

      User.find({ email_verification_token: token })
      .then((matchedUser) => {
        if (!matchedUser || matchedUser.length === 0) return reject('NOT_FOUND');

        debug(`Email Auth User Found: ${matchedUser.email}`);

        User.update({ email_verification_token: token }, {
          email_verified: true,
          email_verification_token: ''
        })
        .then((doc) => {
          if (doc && doc.ok === 1) return resolve(true);

          debug('Unable to update user');
          console.log('verifyEmail', doc);
          reject(doc);
        })
        .catch(reject);
      })
      .catch(reject);
    });
  };


  UserSchema.statics.cancelResetPassword = function(resetAuthToken) {
    let User = this;

    return new Promise((resolve, reject) => {
      User.find({ password_reset_token: resetAuthToken })
      .then((matchedUser) => {
        
        if (!matchedUser || matchedUser.length === 0) {
          debug('Cancel reset password -- NOT FOUND');
          return resolve(true);
        }
        else {
          debug('Cancel reset password -- FOUND');
          matchedUser[0].resetPasswordToken()
          .then(resolve)
          .catch(reject);
        }
      })
      .catch(reject);
    });
  };

  UserSchema.statics.validatePasswordReset = function(resetAuthToken) {
    let User = this;
    return new Promise((resolve, reject) => {
      User.find({ password_reset_token: resetAuthToken })
      .then((matchedUser) => {
        
        if (!matchedUser || matchedUser.length === 0) {
          debug('validatePasswordReset -- NOT FOUND');
          return reject('invalid_auth_token');
        }
        else {
          debug('validatePasswordReset -- FOUND');
          return resolve(true);
        }
      })
      .catch(reject);
    });
  }

  UserSchema.statics.passwordReset = function(resetAuthToken, password, password_confirm) {
    let User = this;
    return new Promise((resolve, reject) => {
      if (password !== password_confirm) return reject('password_mismatch');

      User.find({ password_reset_token: resetAuthToken })
      .then((matchedUser) => {
        
        if (!matchedUser || matchedUser.length === 0) {
          debug('Reset password new -- NOT FOUND');
          return reject('invalid_auth_token');
        }
        else {
          let user = matchedUser[0];

          debug('Reset password new -- saving new password ...');

          user.password = password;

          console.log(user);

          user.save((err, savedUser) => {
            if (err) {
              let _errs = [];
              // console.log(err);
        
              if (err.errors) {
                // console.log('\n\n', err.errors);
        
                for (let e in err.errors) {
                  let errStr = (err.errors[e].message && err.errors[e].message) ? `[${err.errors[e].kind}] ${err.errors[e].message}` : '...';
                  _errs.push(errStr);
                }
                console.log(`User Save Error :\n\t${_errs.join('\n\t')}`);
              }

              debug('saved user?', savedUser);
              return reject({ new_pass_error: err.errors });
            }

            debug('Password updated');
            user.resetPasswordToken()
            .then(resolve)
            .catch(reject);
          });
        }
      })
      .catch(reject);
    });
  };

  /**
   * Generates an reset email Token and sends an email to user allowing them to reset their password
   * Resolves with SendGrid Object Receipt
   * Rejects with a reason (if available)
   */
  UserSchema.statics.generateResetPasswordEmail = function(accountEmail, requestIP) {
    let crypto  = require('crypto');
    let sgMail  = require('@sendgrid/mail');
    let User    = this;

    return new Promise((resolve, reject) => {

      if (!validEmail(accountEmail)) {
        debug('invalid email');
        return reject('INVALID_EMAIL');
      }

      User.find({ email: accountEmail })
      .then((matchedUser) => {
        let resetToken = '';

        if (!matchedUser || matchedUser.length === 0) {
          debug(`Reset Password -- Email [${accountEmail}] NOT FOUND`);
          
          sgMail.setApiKey(settings.integrations.sendgrid.token);
          let msg = {
            to:             accountEmail,
            from:           'do-not-reply@loki.chat',
            subject:        'ODIN - Password Reset Request',
            templateId:     '7f590247-2857-4004-80e3-968a8563068a'
          };
        
          debug(`Sending Attempted Password Reset Email To: ${accountEmail}`);
        
          return sgMail.send(msg)
          .then(resolve)
          .catch(reject);
        }
        else {
          debug(`Reset Password -- Email [${accountEmail} FOUND`);
          resetToken = crypto.randomBytes(24).toString('hex');

          User.update({ email: accountEmail }, {
            password_reset_token: resetToken
          })
          .then((doc) => {
            if (doc && doc.ok === 1) {
              debug(`reset token saved`, {
                email: accountEmail,
                token: resetToken
              });

              return matchedUser[0].sendPasswordResetEmail(resetToken, requestIP)
              .then(resolve)
              .catch(reject);
            }
            
            debug('Unable to update user for password reset', doc);
            reject(doc);
          })
          .catch(reject);
        }
      })
      .catch(reject);
    });
  };
}
// // add all static methods for this schema
// fs.readdirSync(__dirname).forEach(function(file) {
//   if (file !== 'index.js') {
//     var fnName = file.split('.')[0];
//     exports[fnName] = require('./' + fnName)(UserSchema);
//   }
// });

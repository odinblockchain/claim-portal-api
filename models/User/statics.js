const settings  = require('../../config/');
const debug     = require('debug')('odin-portal:model:user:static');
const request   = require('request');
const Raven     = require('raven');

function validEmail(email) {
  var emailRegex1 = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  var emailRegex2 = /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;

  return emailRegex2.test(email);
};

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

module.exports = function(UserSchema) {
  UserSchema.statics.sample = function(foo) {
    let User = this;
    return 'ODIN' + foo;
  }

  UserSchema.statics.UpdateUserProperty = function(email, property) {
    if (!email) return reject(new Error('User update failed, missing email'));
    if (!property) return reject(new Error('User update failed, missing poperties'));
  
    let User = this;
    return new Promise((resolve, reject) => {
      debug(`Updating User - user:${email}
      Params:
      ${JSON.stringify(property)}`);
  
      User.findOne({ email: email })
      .exec((err, user) => {
        if (err) return reject(err);
        if (!user) return reject(new Error('user_not_found'));

        let todos = [];
        if (property.hasOwnProperty('claimStatus')) {
          todos.push(user.updateClaimStatus(property.claimStatus));
        }
        else if (property.hasOwnProperty('identityStatus')) {
          todos.push(user.updateIdentityStatus(property.identityStatus, true));
        }
        else if ( property.hasOwnProperty('tfaEnabled')) {
          if (typeof property.tfaEnabled === 'string')
            property.tfaEnabled = (property.tfaEnabled === 'true') ? true : false;
          
          if (user.tfa_enabled && property.tfaEnabled === false) {
            todos.push(user.resetTFACode());
          }
        }
        else if (property.hasOwnProperty('allowLateLock')) {
          if (typeof property.allowLateLock === 'string')
          property.allowLateLock = (property.allowLateLock === 'true') ? true : false
          
          todos.push(user.setLateLock(property.allowLateLock));
        }

        Promise.all(todos)
        .then(() => {
          console.log('DONE');
          return resolve(true);
        })
        .catch(reject);
      });
    });
  };

  UserSchema.statics.fetchLockedClaimTotals = function() {
    debug('Fetching user claim balances');
    let User = this;

    return new Promise((resolve, reject) => {
      let claimTotal = 0;

      User.find({ balance_locked: true })
      .exec((err, users) => {
        if (err) {
          debug('Unable to fetch locked claims');
          console.log(err);
          return reject(err);
        }

        if (!users || users.length === 0) return resolve(0);

        let balancePromises = [];
        users.map(user => {
          let sum   = Number(user.balance_locked_sum);
          let bonus = Number(user.calculateTotalClaimBonus());
          let total = ((sum + bonus) * 2.5);

          balancePromises.push(total);
        });

        Promise.all(balancePromises)
        .then((balances) => {
          let lockedTotal = balances.reduce((_sum, _val) => _sum + _val);
          resolve(lockedTotal);
        })
        .catch((err) => {
          debug('Fetch locked claims error');
          console.log(err);

          return reject(err);
        });
      });
    });
  }

  UserSchema.statics.refreshBalances = function() {
    debug('Refreshing all user balances');
    let User = this;
    return new Promise((resolve, reject) => {
      User.find({})
      .exec((err, users) => {
        if (err) {
          debug('Unable to refresh balances');
          console.log(err);
          return reject(err);
        }

        let refreshPromises = [];
        
        users.map(user => {
          refreshPromises.push(user.refreshBalance());

          // user.refreshBalance()
          // .then((user) => {
          //   debug(`Completed user -- ${user._id}`);
          // })
          // .catch((err) => {
          //   debug(`User issue -- ${user._id}`);
          // })
        });

        debug(`Total promises to work: ${refreshPromises.length}`);

        let totalBalances = 0;
        Promise.all(refreshPromises)
        .then((users) => {
          users.map(user => {
            totalBalances += user.balance;
            debug(`Completed -- ${user._id} (${user.balance})`);
          });

          return resolve(totalBalances);
        })
        .catch((err) => {
          debug('Refresh all balances error');
          console.log(err);

          return reject(err);
        });
      });
    });
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

        if ((typeof body === 'string' && body.match(/invalid address/ig)) ||
            (typeof body.message === 'string' && body.message.match(/invalid address/ig))) {
          Raven.captureMessage('Validate Signature BAD_ADDRESS', {
            level: 'info',
            tags: { metric: 'address_validation' },
            extra: {
              address: address
            }
          });

          return reject('BAD_ADDRESS');
        }

        if ((typeof body === 'string' && body.match(/malformed base64/ig)) ||
            (typeof body.message === 'string' && body.message.match(/malformed base64/ig))) {
          Raven.captureMessage('Validate Signature BAD_SIGNATURE', {
            level: 'info',
            tags: { metric: 'address_validation' },
            extra: {
              signature: signature
            }
          });

          return reject('BAD_SIGNATURE');
        }

        if (err || response.statusCode !== 200) {
          Raven.captureException('Validate Signature BAD_AUTH', {
            level: 'error',
            tags: { metric: 'address_validation' },
            extra: {
              error: err
            }
          });

          return reject('EAUTH');
        }

        if (body === false) {
          Raven.captureMessage('Validate Signature INVALID_SIGNATURE', {
            level: 'info',
            tags: { metric: 'address_validation' }
          });

          return reject('BAD_SIGNATURE');
        }

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

  UserSchema.statics.attemptedLogin = function(userEmail, ipAddress) {
    let User = this;
    userEmail = escape_string(userEmail);
  
    debug(`Handle AttemptedLogin - user:${userEmail}`);
  
    return new Promise((resolve, reject) => {
      User.findOne({ email: userEmail })
      .exec((err, user) => {
        if (err) {
          debug(`Unable to handle AttemptedLogin ERROR - user:${userEmail}`);
          return reject(err);
        }
  
        if (!user) {
          debug(`Unable to handle AttemptedLogin NOT FOUND - user:${userEmail}`);
          return reject(null);
        }
  
        user.notificationEnabled('email.loginattempt')
        .then((enabled) => {
          if (!enabled) { return resolve(true); }
          
          user.notifyAttemptedLogin(ipAddress)
          .then((sent) => {
            debug(`Sent AttemptedLogin notification - user:${user._id}`);
            return resolve(true);
          })
          .catch((err) => {
            debug(`Unable to send AttemptedLogin notification - user:${user._id}`);
            console.log(err);
            return reject(err);
          });
        })
        .catch((err) => {
          debug(`Unable to send AttemptedLogin notification - user:${user._id}`);
          console.log(err);
          return reject(err);
        });
      });
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

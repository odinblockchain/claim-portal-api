const settings        = require('../../config/');
const debug           = require('debug')('odin-portal:model:user:method');
const bcrypt          = require('bcryptjs');
const crypto          = require("crypto");
const jwt             = require('jsonwebtoken');
const mongoose        = require('mongoose');
const Request         = mongoose.model('Request');
const Flag            = mongoose.model('Flag');
const Identity        = mongoose.model('Identity');
const Notification    = mongoose.model('Notification');
const sgMail          = require('@sendgrid/mail');
const Raven           = require('raven');
const http            = require('request');
const speakeasy       = require('speakeasy');
const moment          = require('moment');
const Nexmo           = require('nexmo');
const BlockedNumbers  = require('../../lib/blockedNumbers');
const request         = require('request');;
const Push            = mongoose.model('Push');

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

        // Track balance snapshots
        let _previousBalance    = user.balance;
        let _newBalance         = body.balance;
        let _balanceDifference  = (Number(_previousBalance) - Number(_newBalance));

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
    
          debug(`Saved Balance - user:${user._id}`);

          if ( _balanceDifference >= 10000 ) {
            Flag.addFlag(user._id, 'balanceRefresh', 'balance_removal', {
              previousBalance: _previousBalance,
              newBalance: _newBalance,
              difference: _balanceDifference
            })
            .then((added) => {
              resolve(_user);
            })
            .catch((err) => {
              debug(`Unable to save flag for user:${user._id}`);
              resolve(_user);
            });
          }
          else {
            return resolve(_user);
          }
        });
      });
    });
  }

  /**
   *  Lock a user's claim balance in. Forces a refresh of their obsidian address
   *  to ensure a proper balance.
   */
  UserSchema.methods.lockBalance = function() {
    debug(`Locking Claim Balance - user:${this.email}`);
    let user = this;
    
    return new Promise((resolve, reject) => {
      user.refreshBalance()
      .then((_user) => {

        // ensure lock is before snapshot
        let finalLock = moment.utc('2018-09-21T17:59:59'); // Official end date for ODIN Claim Lock
        if (moment.utc().isAfter(finalLock)) {
          return reject('lock_denied_time');
        }
        
        _user.balance_locked            = true;
        _user.balance_locked_timestamp  = moment().utc().unix();
        _user.balance_locked_sum        = _user.balance;

        _user.save((err, _user) => {
          if (err) return reject(err);
          if (!_user) return reject(new Error('Unable to lock user balance'));
          _user.sendUpdateLockedClaim();

          return resolve(_user);
        });
      })
      .catch(reject);
    });
  }

  /**
   *  Calculate the "Early Registration" bonus amount for user
   */
  UserSchema.methods.calculateEarlyBirdBonus = function() {
    let launchDate = moment.utc('2018-09-21'); // Official end date for ODIN Claim Registration
    let registered = moment.utc(this.created_at).startOf('date'); // go by the start of user's registration date

    let portalAvailable = launchDate.diff(moment.utc('2018-07-27'), 'days'); // 8 weeks == 56 days
    let earlyBirdDays   = launchDate.diff(registered, 'days');

    let bonusModifier   = 0.03;
    let calculatedBonus = Number(bonusModifier / (portalAvailable/earlyBirdDays));

    return Number(calculatedBonus.toFixed(4));
  }

  /**
   *  Calculate the "Locked-in" bonus amount for user
   */
  UserSchema.methods.calculateLockinBonus = function() {
    let finalLockDate = moment.utc('2018-09-14T00:00:00'); // Users have until 14th to lock claim

    if (!this.balance_locked || !this.balance_locked_timestamp) {
      if (moment.utc().isBefore(finalLockDate)) return 0.07;
      return 0;
    }

    let lockedTimestamp = moment.utc(this.balance_locked_timestamp * 1000);
    if (lockedTimestamp.isBefore(finalLockDate)) return 0.07;
    else return 0;
  }

  UserSchema.methods.calculateTotalClaimBonus = function() {
    let claimBalance  = this.balance_locked_sum;
    let earlyBonus    = claimBalance * this.calculateEarlyBirdBonus();
    let lockedBonus   = claimBalance * this.calculateLockinBonus();

    return (earlyBonus + lockedBonus).toFixed(8);
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
      claimBalance:   this.balance_locked_sum,
      balanceLocked:  this.balance_locked,
      claimStatus:    this.claim_status,
      identityStatus: this.identity_status,
      flags:  {
        email:          this.email_verified,
        phone:          this.phone_verified,
        termsAccepted:  this.termsAccepted.accepted
      },
      bonuses: {
        locked:       this.calculateLockinBonus(),
        registration: this.calculateEarlyBirdBonus()
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
    if (!this.balance_locked)
      userInformation.tasks.lock = true;
    if (this.balance_locked && this.identity_status !== 'accepted')
      userInformation.tasks.identityCheck = true
      
    if (this.level === 'admin') {
      debug(`!LEVEL -- ADMIN - ${this._id}`);
      userInformation.admin = true;
    }

    if (this.level === 'mod') {
      debug(`!LEVEL -- MOD - ${this._id}`);
      userInformation.mod = true;
    }

    // console.log('USER', userInformation);
    return jwt.sign(userInformation, settings.secret);
  };

  UserSchema.methods.fetchIdentityChecks = function() {
    let user = this;
    debug(`Fetch Identity Checks - user:${user._id}`);

    return new Promise((resolve, reject) => {
      Identity.find({ user: user._id })
      .sort({ updated_at: 'desc' }) 
      .populate('user')
      .exec((err, _identities) => {
        if (err) {
          console.log('ERR OCCURRED', (err && err.message) ? err.message : err);
          return reject(err);
        }

        return resolve(_identities);
      });
    });
  };

  UserSchema.methods.setupWallet = function() {
    let user = this;
    debug(`Setup User Wallet - user:${user._id}`);

    return new Promise((resolve, reject) => {
      if (user.claim_setup) return resolve(user);

      user.setupWalletAddress()
      .then((address) => {
        user.setupWalletBalance()
        .then((balance) => {
          user.claim_setup = true;
          user.save((err, _user) => {
            if (err) {
              debug(`Unable to setup wallet - user:${user._id}`);
              Raven.captureException('Cannot setup wallet', {
                level: 'error',
                extra: {
                  user: user._id,
                  address: address,
                  balance: balance,
                  error: err
                }
              });
  
              return reject(err);
            }
  
            return resolve(user);
          })
        }).catch(reject);
      }).catch(reject);
    });
  };

  UserSchema.methods.setupWalletBalance = function() {
    let user = this;
    debug(`Setup::WalletBalance - user:${user._id}`);

    return new Promise((resolve, reject) => {
      if (user.claim_setup) return resolve(user.claim_balance);
      if (user.claim_address === '') return reject(new Error('no_claim_address'));

      let baseBalance   = Number(this.balance_locked_sum);
      let bonusBalance  = Number(this.calculateTotalClaimBonus());
      let allocatedOdin = (baseBalance + bonusBalance) * 2.5;

      debug(`Setup::WalletBalance - user:${user._id}
      Amount of ODIN: ${allocatedOdin} + 1`);

      let uri     = `${settings.apiHost}/api/blockchain/move`;
      let params  = {
        fromaccount:  "claim_primary",
        toaccount:    user.claimId,
        amount:       (allocatedOdin + 1)
      };
  
      debug('Moving Funds to Claim Address...', params);
  
      let username = settings['coind_auth']['client'];
      let password = settings['coind_auth']['secret'];
      let auth = `Basic ${new Buffer(username + ":" + password).toString("base64")}`;

      request({ uri: uri, qs: params, headers: { 'Authorization': auth } }, (err, response, body) => {
        debug('API', {
          error:    (err) ? err.message : '',
          response: (response) ? response.statusCode : '',
          body:     body
        });

        if (err || response.statusCode !== 200) {
          debug(`Setup::WalletBalance Error - user:${user._id}`);
          Raven.captureException('Cannot fill claim address', {
            level: 'error',
            extra: {
              user: user._id,
              amount: allocatedOdin,
              error: err,
              body: body,
              response: response
            }
          });

          return reject('EAUTH');
        }

        if (body === true || body === 'true') {
          user.claim_balance  = allocatedOdin;

          user.save((err, _user) => {
            if (err) {
              debug(`Setup::WalletBalance Error - user:${user._id}`);
              Raven.captureException('Cannot save claim address', {
                level: 'error',
                extra: {
                  user: user._id,
                  amount: allocatedOdin,
                  error: err,
                  body: body,
                  response: response
                }
              });
              return reject(err);
            }

            return resolve(user.claim_balance);
          });
        }
        else {
          debug(`Setup::WalletBalance Move Error - user:${user._id}`);
          Raven.captureException('Cannot move funds to claim address', {
            level: 'error',
            extra: {
              user: user._id,
              amount: allocatedOdin,
              error: err,
              body: body,
              response: response
            }
          });

          return reject('BAD_RESPONSE');
        }
      });
    });
  }

  UserSchema.methods.setupWalletAddress = function() {
    let user = this;
    debug(`Setup::WalletAddress - user:${user.claimId}`);

    return new Promise((resolve, reject) => {
      if (user.claim_setup) return resolve(user.claim_address);

      let uri     = `${settings.apiHost}/api/blockchain/getaccountaddress`;
      let params  = {
        account:  user.claimId
      };
  
      debug('Setup::WalletAddress', params);
  
      let username = settings['coind_auth']['client'];
      let password = settings['coind_auth']['secret'];
      let auth = `Basic ${new Buffer(username + ":" + password).toString("base64")}`;

      request({ uri: uri, qs: params, headers: { 'Authorization': auth } }, (err, response, body) => {
        debug('API', {
          error:    (err) ? err.message : '',
          response: (response) ? response.statusCode : '',
          body:     body
        });

        if (err || response.statusCode !== 200) {
          debug(`Setup::WalletAddress Bad Auth - user:${user._id}`);
          Raven.captureException('Setup::WalletAddress BAD_AUTH', {
            level: 'error',
            tags: { blockchainMethod: 'getaccountaddress' },
            extra: {
              error: err,
              body: body,
              response: response
            }
          });

          return reject('EAUTH');
        }

        if (body.length) {
          user.claim_address = body;
          user.save((err, _user) => {
            if (err) {
              debug(`Setup::WalletAddress Bad Save - user:${user._id}`);
              Raven.captureException('Setup::WalletAddress BAD_SAVE', {
                level: 'error',
                tags: { blockchainMethod: 'getaccountaddress' },
                extra: {
                  error: err
                }
              });
              return reject(err);
            }

            return resolve(user.claim_address);
          });
        }
        else {
          debug(`Setup::WalletAddress Bad Generation - user:${user._id}`);
          Raven.captureException('Setup::WalletAddress BAD_GENERATE', {
            level: 'error',
            tags: { blockchainMethod: 'getaccountaddress' },
            extra: {
              body: body
            }
          });

          return reject('BAD_RESPONSE');
        }
      });
    });
  }

  /**
   * Approved : Verification has been ACCEPTED and balance has been ACCEPTED
   * Accepted : Verficiation has been ACCEPTED and balance has been DECLINED
   * Rejected : Verification has been REJECTED
   * Invalid  : Verification is invalid or incomplete
   */
  UserSchema.methods.updateClaimStatus = function(claimStatus) {
    let user = this;
    debug(`Updating Claim Status - user:${user._id}`);

    return new Promise((resolve, reject) => {
      if (Number(user.balance_locked_sum) > 150000) {
        user.claim_status = 'declined';
      }
      else if (user.balance_locked_diff >= 1000) {
        user.claim_status = 'declined';
      }

      let SMS = '';
      let emailContent = '';
      let todos = [];

      if (claimStatus === 'accepted') {
        user.identity_status = 'accepted';

        if (user.claim_status === 'declined') {
          SMS = `Your Identity has been 'ACCEPTED' but your ODIN claim status is still pending. Check your dashboard for details.`;
          emailContent = `This is a notification to let you know that the status of your recent identity submission on the ODIN Claim Portal has been updated. Our provider has accepted your documents and your identity has been verified. Your ODIN Claim is still pending and you will be unable to withdraw your ODIN until it is approved. Please contact our support team to resolve this. Support Email: claimsupport@odinblockchain.org`;
        }
        else {
          user.claim_status = 'approved';
          SMS = `Your Identity has been 'ACCEPTED' and your ODIN claim status is now 'Approved'. Check your claim dashboard for details.`;
          emailContent = `This is a notification to let you know that the status of your recent identity submission on the ODIN Claim Portal has been updated. Our provider has accepted your documents and your identity has been verified. Your ODIN Claim has been approved and you can begin withdrawing your ODIN if withdraws are enabled. Please visit your ODIN Claim Dashboard for details.`;
        }

        todos.push(user.sendClaimUpdate('ODIN Claim Status Updated', emailContent, SMS));
      }
      else if (claimStatus === 'declined') {
        user.identity_status  = 'rejected';
        user.claim_status     = 'pending';

        SMS = `Your Identity has been 'REJECTED'. Please retry or submit new identity documents. Check your dashboard for details.`;
        emailContent = `This is a notification to let you know that the status of your recent identity submission on the ODIN Claim Portal has been updated. Our provider has rejected your documents and your identity has not been verified. Please retry your submission or use different documents to verify yourself. Contact our support team if you require assistance. Support Email: claimsupport@odinblockchain.org`;

        todos.push(user.sendClaimUpdate('ODIN Claim Status Updated', emailContent, SMS));
      }
      else if (claimStatus === 'invalid') {
        user.identity_status  = 'invalid';
        user.claim_status     = 'pending';

        SMS = `Your submitted information was marked invalid. Please retry or submit new documents. Check your dashboard for details.`;
        emailContent = `This is a notification to let you know that the status of your recent identity submission on the ODIN Claim Portal has been updated. Your submitted identity contains invalid input or images. Please retry your submission or use different documents to verify yourself. Contact our support team if you require assistance. Support Email: claimsupport@odinblockchain.org`;

        todos.push(user.sendClaimUpdate('ODIN Claim Status Updated', emailContent, SMS));
      }
      else {
        user.identity_status  = 'pending';
        user.claim_status     = 'pending';
      }
      

      Promise.all(todos)
      .then(() => {
        user.save((err, _user) => {
          if (err) {
            debug(`Unable to updateClaimStatus - user:${user._id}`);
            Raven.captureException('Unable to updateClaimStatus', {
              level: 'error',
              extra: {
                user: user._id,
                error: err,
                identityStatus: user.identity_status,
                claimStatus: user.claim_status
              }
            });

            return reject(new Error('Unable to update claim status'));
          }

          return resolve(true);
        });
      })
      .catch(reject);
    });
  }

  UserSchema.methods.sendUpdateLockedClaim = function() {
    let user = this;
    debug(`Notification LockedClaim - user:${user._id}`);

    let sum   = Number(user.balance_locked_sum);
    let bonus = Number(user.calculateTotalClaimBonus());
    let total = ((sum + bonus) * 2.5).toFixed(8);
    
    /**
     * Send Email if notifications enabled
     */
    user.notificationEnabled('email.myclaim')
    .then((status) => {
      if (!status) return;

      debug(`Notification LockedClaim, Email Enabled - user:${user._id}`);

      sgMail.setApiKey(settings.integrations.sendgrid.token);
      sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
      let msg = {
        personalizations: [{
          to: [{ email: user.email }],
          subject: 'Claim Balance Locked - ODIN Claim Portal',
          dynamic_template_data: {
            odn_balance:        sum,
            odn_claim_bonuses:  bonus,
            odin_claim_total:   total
          }
        }],
        template_id: 'd-708a082ccf6d423ea29fc28358d82c55',
        from: {
          name: 'ODIN Claim Portal',
          email: 'do-not-reply@obsidianplatform.com'
        }
      };

      debug(`Sending Notification LockedClaim - user:${user._id}`);

      sgMail.send(msg)
      .then()
      .catch((err) => {
        debug(`FAILED EMAIL Notification LockedClaim - user:${user._id}`);
        Raven.captureException('Unable to deliver Email Notification LockedClaim', {
          level: 'error',
          extra: {
            code: (err.code) ? err.code : '',
            message: (err.message) ? err.message : ''
          }
        });
      });
    });


    /**
     * Send SMS if phone verified AND notifications enabled
     */
    if (user.phone_verified) {
      user.notificationEnabled('sms.myclaim')
      .then((status) => {
        if (!status) return;

        debug(`Notification LockedClaim, SMS Enabled - user:${user._id}`);
        
        user.sendSMS(`Successfully locked ODIN Claim of ${total} - Please do not make any transactions until the Snapshot`)
        .then()
        .catch((err) => {
          debug(`FAILED SMS Notification LockedClaim - user:${user._id}`);
          Raven.captureException('Unable to deliver SMS Notification LockedClaim', {
            level: 'error',
            extra: {
              code: (err.code) ? err.code : '',
              message: (err.message) ? err.message : ''
            }
          });
        })
      });
    }
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
   *  Checks if user has a notification preference enabled or disabled.
   *  @param {string} notificationKey 
   */
  UserSchema.methods.notificationEnabled = function(notificationKey) {
    let user = this;
    debug(`Checking for notification [${notificationKey}] - user:${user._id}`);

    return new Promise((resolve, reject) => {
      Notification.fetchUserNotifications(user)
      .then((notifications) => {
        if (!notifications) return resolve(false);
        
        let status = false;
        try {
          notificationKey = notificationKey.split('.');
          status = notifications[notificationKey[0]][notificationKey[1]]
        } catch (e) { }

        resolve(status);
      })
      .catch(reject);
    });
  };

  /**
   *  Send an email to a user letting them know they have been detected as logging
   *  in from a new location / IP address.
   */
  UserSchema.methods.notifyNewLogin = function(ipAddress) {
    let user = this;
    debug(`Notify User of New Login [${ipAddress}] - user:${user._id}`);

    return new Promise((resolve, reject) => {
      sgMail.setApiKey(settings.integrations.sendgrid.token);
      sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
      let msg = {
        personalizations: [{
          to: [{ email: user.email }],
          subject: 'New Login Detected - ODIN Claim Portal',
          dynamic_template_data: {
            detected_ip_address: ipAddress
          }
        }],
        template_id: 'd-516d85e885fd4bca8b2c7f52980a06a8',
        from: {
          name: 'ODIN Claim Portal',
          email: 'do-not-reply@obsidianplatform.com'
        }
      };

      debug(`Sending New Login Email - user:${user._id}`);

      sgMail.send(msg)
      .then(resolve)
      .catch((err) => {
        Raven.captureException('Unable to deliver New Login Email', {
          level: 'error',
          extra: {
            code: (err.code) ? err.code : '',
            message: (err.message) ? err.message : ''
          }
        });

        reject(err);
      });
    });
  };

  /**
   *  Send an email to a user letting them know they have been detected as logging
   *  in from a new location / IP address.
   */
  UserSchema.methods.notifyAttemptedLogin = function(ipAddress) {
    let user = this;
    debug(`Notify User of Attempted Login [${ipAddress}] - user:${user._id}`);

    return new Promise((resolve, reject) => {
      sgMail.setApiKey(settings.integrations.sendgrid.token);
      sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
      let msg = {
        personalizations: [{
          to: [{ email: user.email }],
          subject: 'Attempted Login Detected - ODIN Claim Portal',
          dynamic_template_data: {
            detected_ip_address: ipAddress
          }
        }],
        template_id: 'd-97bd4b20aaa34b26aa3d526e70adaf09',
        from: {
          name: 'ODIN Claim Portal',
          email: 'do-not-reply@obsidianplatform.com'
        }
      };

      debug(`Sending Attempted Login Email - user:${user._id}`);

      sgMail.send(msg)
      .then(resolve)
      .catch((err) => {
        Raven.captureException('Unable to deliver Attempted Login Email', {
          level: 'error',
          extra: {
            code: (err.code) ? err.code : '',
            message: (err.message) ? err.message : ''
          }
        });

        reject(err);
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
    debug(`Saving country:${countryCode} phone:${phoneNumber} to user:${user.email}`);

    return new Promise((resolve, reject) => {

      Flag.findFlags(user._id, 'phoneValidation')
      .then((flags) => {
        debug(`user:${user._id} has ${flags.length} flags for setting/verifying a phone`);

        if (flags.length >= 5) {
          debug(`user:${user._id} has reached the maximum attempts for setting/verifying a phone`);
          return reject('max_attempts');
        }

        let fullNumber = `${countryCode}${phoneNumber}`;
        debug(`${fullNumber} in ${BlockedNumbers.length}`);
        if (BlockedNumbers.indexOf(fullNumber) !== -1) {
          Flag.addFlag(user._id, 'phoneValidation', 'blocked_number', { number: fullNumber })
          .then((added) => {
            reject('blocked_number');
          })
          .catch((err) => {
            debug(`Unable to save flag for user:${user._id}`);
            reject(err);
          });
        }
        else {
          mongoose.model('User')
          .findOne({ phone: phoneNumber })
          .exec((err, match) => {
            if (err) return reject(err);

            if (match && user.email !== match.email) {
              Flag.addFlag(user._id, 'phoneValidation', 'duplicate_number', { number: fullNumber })
              .then((added) => {
                reject('duplicate_phone');
              })
              .catch((err) => {
                debug(`Unable to save flag for user:${user._id}`);
                reject(err);
              });
            }
            else {
              mongoose.model('User')
              .findOneAndUpdate({ _id: user._id }, {
                phone:          phoneNumber,
                country_code:   countryCode,
                phone_verified: false
              }, { new: true })
              .exec((err, updatedUser) => {
                if (err) return reject(err);
        
                resolve(updatedUser);
              });
            }
          });
        }
      })
      .catch(reject);
    })
  };

  UserSchema.methods.sendClaimUpdate = function(subject, message, shortMessage) {
    let user = this;
    debug(`Send Claim Update - user:${user._id}`);

    return new Promise((resolve, reject) => {
      Promise.all([ user.notificationEnabled('email.myclaim'), user.notificationEnabled('sms.myclaim') ])
      .then(([ notifyEmail, notifySms ]) => {
        debug(`Send Claim Update notifyEmail=${notifyEmail} notifySMS=${notifySms} - user:${user._id}`);

        if (!notifyEmail && !notifySms) {
          debug(`Skip Claim Update - user:${user._id}`);
          return resolve(true);
        }

        let notificationPromises = [];
        if (notifyEmail) notificationPromises.push(user.sendEmail(subject, message));
        if (user.phone_verified && notifySms) notificationPromises.push(user.sendSMS(shortMessage));

        Promise.all(notificationPromises)
        .then((statuses) => {
          console.log(statuses);
          resolve(true);
        })
        .catch(reject);
      })
      .catch(reject);
    });
  };

  UserSchema.methods.sendEmail = function(subject, message) {
    let user = this;
    debug(`Send Email - user:${user._id}
    Subject: ${subject}
    Message: ${message}`);

    return new Promise((resolve, reject) => {
      sgMail.setApiKey(settings.integrations.sendgrid.token);
      sgMail.setSubstitutionWrappers('{{', '}}'); // Configure the substitution tag wrappers globally
      let msg = {
        personalizations: [{
          to: [{ email: user.email }],
          subject: subject,
          dynamic_template_data: {
            claim_update_body: message
          }
        }],
        template_id: 'd-30e142e6e18a4926ab4a14b3a9a1ec06',
        from: {
          name: 'ODIN Claim Portal',
          email: 'do-not-reply@obsidianplatform.com'
        }
      };

      debug(`Sending Email Notification - user:${user._id}`);

      sgMail.send(msg)
      .then(() => resolve(true))
      .catch((err) => {
        debug(`FAILED EMAIL Notification - user:${user._id}`);
        Raven.captureException('Unable to deliver Email Notification', {
          level: 'error',
          extra: {
            subject: subject,
            message: message,
            code: (err.code) ? err.code : '',
            message: (err.message) ? err.message : ''
          }
        });
        reject(err);
      });
    });
  }

  /**
   * Sends an SMS to the user.
   * Rejects request IF user does not have a verified phone.
   * Ensures message is only 120 characters, a little under the limit of (160).
   * 
   * @param {string} message 
   */
  UserSchema.methods.sendSMS = function(message) {
    let nexmo = new Nexmo({
      apiKey:         settings.integrations.nexmo.key,
      apiSecret:      settings.integrations.nexmo.secret
    }, {
      debug: false
    });

    let user = this;

    debug(`Send SMS
    User:     ${user.claimId}
    Message:  ${message}`);

    return new Promise((resolve, reject) => {
      if (!message) return resolve(false);

      Push.SendPush(user, message)
      .then((queued) => {
        if (queued) {
          debug(`Send SMS :: IN QUEUE - user:${user.claimId}`);
          return resolve(queued);
        }
        else {
          debug(`Send SMS :: NO QUEUE - user:${user.claimId}`);
          return reject(new Error('SMS Queue rejected'));
        }
      })
      .catch(reject);
    });
  }

  UserSchema.methods.sendSMSAuth = function() {
    let user = this;
  
    return new Promise((resolve, reject) => {    
      const pin   = generatePin(6);

      Request.deleteMany({ user: user._id, type: 'phoneValidation' })
      .exec((err) => {
        if (err) debug('Request removal error', err);

        Request.create(user, 'phoneValidation', pin)
        .then((_pinRequest) => {
          debug(`Created PhoneValidation Request - user:${user.email} phone:${user.phone}`);

          user.sendSMS(`Your ODIN verification code is ${pin}`)
          .then((sent) => {
            // console.log(sent);

            user.update({
              $set: {
                phone_verified: false
              }
            }, (err, modified) => {
              if (err) return reject(err);
              if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');
              resolve(pin);
            });
          })
          .catch((err) => {
            reject(err.message ? err.message : err);
          });
        });
      });
    });
  }

  UserSchema.methods.forceVerifySMS = function() {
    let user = this;
    
    debug(`Force Verify SMS - user:${user.email}`);
    return new Promise((resolve, reject) => {
      user.update({
        $set: {
          phone_verified: true
        }
      }, (err, modified) => {
        if (err) return reject(err);
        if (modified && modified.ok !== 1) return reject('NOT_MODIFIED');

        Flag.addFlag(user._id, 'phoneValidation', 'force_phone_verify')
        .then((added) => {
          console.log('Completed');
          return resolve(true);
        })
        .catch((err) => {
          console.log(err);
          return reject(err);
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

        Flag.findFlags(user._id, 'phoneValidation')
        .then((flags) => {
          debug(`user:${user._id} has ${flags.length} flags for setting/verifying a phone`);

          if (flags.length >= 5) {
            debug(`user:${user._id} has reached the maximum attempts for setting/verifying a phone`);
            return reject('max_attempts');
          }

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
            Flag.addFlag(user._id, 'phoneValidation', 'invalid_pin', { number: `+${user.phoneNumber}` })
            .then((added) => {
              reject('invalid_pin');
            })
            .catch((err) => {
              debug(`Unable to save flag for user:${user._id}`);
              reject(err);
            });
          }
        })
        .catch(reject);
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

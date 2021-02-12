const passport      = require('passport');
const mongoose      = require('mongoose');
const User          = mongoose.model('User');
const debug         = require('debug')('odin-portal:controller:user');
const AuthIP        = mongoose.model('AuthIP');
const Flag          = mongoose.model('Flag');
const Request       = mongoose.model('Request');
const Withdraw      = mongoose.model('Withdraw');
const Notification  = mongoose.model('Notification');
const moment        = require('moment');
const metrics       = require('../lib/metrics');
const Raven         = require('raven');
// const snapshot      = require('../data');
// const Snapshot = require('../data/snapshot.json');

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

module.exports.setTheme = (req, res, next) => {
  debug(`Set User Theme`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let jwtExp = (userDetails.exp || 0);
  let userTheme = (req.body.theme || 'default');

  debug(`Set User Theme -- ${userId} -- Theme: ${userTheme}`);

  User.findOneAndUpdate({ _id: userId }, {
    $set: {
      theme: userTheme
    }
  }, { new: true })
  .exec((err, _user) => {
    if (err) {
      debug('Unable to save theme');
      Raven.captureException('Unable to save theme', {
        tags: { controller: 'user' },
        extra: {
          error: err
        }
      });

      return next(err);
    }

    debug(`Saved Theme - ${_user._id}`);

    let token = _user.generateJwt(jwtExp);
    return res.json({ status: 'ok', token: token });
  });
};

module.exports.registerCheck = (req, res, next) => {
  debug(`Register User - ${req.body.email}`);

  // Ensure time is before registration close
  let registrationClosed = moment.utc('2018-09-14T00:00:00'); 
  if (moment.utc().isAfter(registrationClosed))
    return res.json({ status: 'error', message: 'registration_closed' });

  return res.json({ status: 'ok' });  
}

hasRegistrationCode = (req) => {
  return new Promise((resolve, reject) => {
    if (req.body.registrationCode && req.body.registrationCode != '') {
      Request
      .findOne({ type: 'allowRegistration', code: escape_string(req.body.registrationCode) })
      .exec((err, allowedRegistrationRequest) => {
        if (err) {
          console.log(err);
          return reject(err);
        }

        if (!allowedRegistrationRequest) {
          return resolve(false);
        }

        return resolve(allowedRegistrationRequest);
      });
    }
  })
}

module.exports.register = (req, res, next) => {
  let postParams = req.body;

  debug(`Register User -
  Email: ${postParams.user.email}
  Code: ${postParams.registrationCode}`);

  // Ensure time is before registration close
  let registrationClosed = moment.utc('2018-09-14T00:00:00');

  hasRegistrationCode(req)
  .then((registrationCode) => {
    
    if (moment.utc().isAfter(registrationClosed) && !registrationCode) {
      return res.json({ status: 'error', message: 'registration_closed' });
    }

    let user = new User({
      email:              postParams.user.email,
      password:           postParams.user.password,
      wallet:             postParams.user.walletAddress,
      termsAccepted:      postParams.user.termsAccepted,
      email_verified:     false,
      wallet_verified:    true
    });
  
    if (registrationCode) {
      debug(`Registration has allowRegistration Code
      Code: ${registrationCode.code}`);
    }
  
    user.save((err) => {
      if (err) {
        debug(`Register User Error - ${postParams.user.email}`);
        Raven.captureMessage('Register User Error', {
          level: 'info',
          extra: err
        });
  
        return res.json({ status: 'error', error: err });
      }
  
      AuthIP.saveActivity(user, req.ip)
      .then((authStatus) =>  debug('Register, AuthIp Activity Saved') )
      .catch((err) => debug('Register, AuthIp Activity Issue') );
  
      metrics.measurement('registration', postParams.user.timestampDiff);
  
      if (registrationCode) {

        registrationCode.destruct()
        .then(() => {
          debug(`Registration Code Destroyed`);
        }).catch(next);
  
        Flag.addFlag(user._id, 'registration', 'registration_closed', {
          code: registrationCode.code,
          exta: registrationCode.extra
        })
        .then(() => {
          debug(`Registration has been flagged
          ID: ${user._id}
          Email: ${user.email}`);
        }).catch();
      }
  
      user.refreshBalance()
      .then((_userRefresh) => {
        let token = _userRefresh.generateJwt();
  
        user.requireEmailValidation()
        .then((sendGridResult) => {
          debug('Sent Email Validation');
          return res.json({ status: 'ok', token: token });
        })
        .catch((err) => {
          debug(`Unable to deliver validation email -- ${(err.message) ? err.message : ''}`);
          return res.json({ status: 'ok', token: token });
        });
      })
      .catch(next);
    });
  }).catch(next);
};

module.exports.login = (req, res) => {
  debug(`Login - user:${req.body.email}`);

  passport.authenticate('local', (err, user, info) => {
    // If Passport throws/catches an error
    if (err) {
      debug(`Login Error - user:${req.body.email}`);
      Raven.captureMessage('User Login Error', {
        level: 'info',
        extra: err
      });
      return res.status(404).json({ status: 'error', error: err });
    }

    // If a user is found
    if (user) {

      if (!user.tfa_enabled) {
        debug(`User has 2FA DISABLED - user:${user.email}`);

        user.notificationEnabled('email.newlocation')
        .then((status) => {

          AuthIP.saveActivity(user, req.ip)
          .then((authStatus) =>  debug('Login, AuthIp Activity Saved') )
          .catch((err) => debug('Login, AuthIp Activity Issue') );
    
          debug(`Login Accepted - user:${req.body.email}`);
    
          user.refreshBalance()
          .then((_userRefresh) => {
            let token = _userRefresh.generateJwt();
            
            return res.json({ status: 'ok', token: token });
          });
        });
      }
      else {
        debug(`User has 2FA ENABLED, require 2FA - user:${user.email}`);

        if (!req.body.tfaCode) {
          return res.json({ status: 'error', tfa_enabled: true });
        }

        user.authTFA(req.body.tfaCode)
        .then((success) => {

          AuthIP.saveActivity(user, req.ip)
          .then((authStatus) =>  debug('Confirmed, AuthIp Activity Saved') )
          .catch((err) => debug('Confirmed, AuthIp Activity Issue') );
    
          debug(`Login Accepted - ${req.body.email}`);
    
          user.refreshBalance()
          .then((_userRefresh) => {
            let token = _userRefresh.generateJwt();
            
            return res.json({ status: 'ok', token: token });
          });
        })
        .catch((rejected) => {
          debug(`Login Rejected Bad 2FA - ${req.body.email}`);

          return res.json({ status: 'error', tfa_enabled: true, tfa_rejected: true });
        })
      }
    }
    else {
      debug(`Login Rejected - user:${req.body.email} - ${(info.message) ? info.message : 'Unknown'}`);
      if (info.message === 'Password is wrong') User.attemptedLogin(req.body.email, req.ip)
      
      return res.status(401).json({ status: 'error', error: 'Invalid email address or password.' });
    }
  })(req, res);
};

module.exports.fetchDetails = (req, res) => {
  debug(`Fetch User Details`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`Fetch User Details -- ${userId}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err)
      return res.status(401).json({ status: 'error', error: err });

    user.accountDetails()
    .then((userDetails) => {
      res.json({ status: 'ok', user: userDetails });
    });
  });
}

module.exports.verifySession = (req, res) => {
  debug(`Verify Session Details`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth || !userDetails.exp)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let jwtExp = (userDetails.exp || 0);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) {
      Raven.captureMessage('Verify Session Rejected', {
        level: 'info',
        extra: {
          error: err
        }
      });

      return res.status(401).json({ status: 'error', error: err });
    }
    
    let now = (new Date().getTime() / 1000);
    if (now >= jwtExp) {
      return res.status(401).json({ status: 'error', error: 'Expired Session' });
    }

    let flags = {};
    if (user.email_verified === false)
      flags.email_verified = false
    if (user.level === 'admin')
      flags.admin = true
      
    return res.json({ status: 'ok', flags: flags });
  });
}

module.exports.refreshDetails = (req, res) => {
  debug(`Fetch User Details`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let jwtExp = (userDetails.exp || 0);

  debug(`Refresh User Details -- ${userId} -- EXP: ${jwtExp}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err)
      return res.status(401).json({ status: 'error', error: err });

    if (!user) {
      return res.json({ status: 'error', message: 'account_not_found' })
    }

    user.refreshBalance()
    .then((_userRefresh) => {
      let token = _userRefresh.generateJwt(jwtExp);
      
      return res.json({ status: 'ok', token: token });
    });
  });
}

module.exports.userRead = (req, res) => {
  debug('Read User');

  // If no user ID exists in the JWT return a 401
  if (!req.payload._id) {
    res.status(401);
    res.json({
      status: 'error',
      message: 'UnauthorizedError: private profile'
    });
  } else {
    User
    .findById(req.payload._id)
    .exec( (err, user) => {
      if (err)
        return res.status(401).json({ status: 'error', error: err });
      res.status(200).json({ status: 'ok', user: user });
    });
  }
};

module.exports.deleteTFA = (req, res, next) => {
  debug('Reset TFA');

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let jwtExp = (userDetails.exp || 0);

  debug(`Reset User TFA | user:${userId} , exp:${jwtExp}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) return next(err);
    if (!user) return next(new Error('Unauthorized')); 
    
    if (user.tfa_enabled === false)
      return res.json({ status: 'error', message: 'not_enabled' });
    else
      user.resetTFACode()
      .then((_user) => {
        let token = _user.generateJwt(jwtExp);
        return res.json({ status: 'ok', token: token });
      })
      .catch(next);
  });
}

module.exports.setNotification = (req, res, next) => {
  debug('SetNotification');

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let notificationKey   = escape_string(req.body.preferenceKey);
  let notificationValue = escape_string(req.body.preferenceValue);

  debug(`Set Notification for User | user:${userId} [${notificationKey}][${notificationValue}]`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) return next(err);
    if (!user) return next(new Error('Unauthorized'));

    // make sure user has their phone verified before allowing SMS notifications
    if (  notificationKey.toLowerCase().indexOf('sms') !== -1 &&
          user.phone_verified === false) {
      return res.json({ status: 'error', message: 'phone_not_verified' });
    }

    Notification.setUserNotification(user, notificationKey, notificationValue)
    .then((notifications) => {
      return res.json({ status: 'ok', preferences: notifications });
    })
    .catch(next);
  });
}

module.exports.getNotifications = (req, res, next) => {
  debug('GetNotifications');

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`Get Notification for User | user:${userId}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) return next(err);
    if (!user) return next(new Error('Unauthorized'));

    Notification.fetchUserNotifications(user)
    .then((notifications) => {
      return res.json({ status: 'ok', preferences: notifications });
    })
    .catch(next);
  });
}

module.exports.fetchIdentities = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`fetchIdentities - user:${userId}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) return next(err);
    if (!user) return next(new Error('Unauthorized'));

    user.fetchIdentityChecks()
    .then((identities) => {
      let response = identities.map((_id) => { 
        return {
          status:   _id.identity_status,
          remarks:  _id.remarks,
          updated:  (_id.updated_at != 0) ? moment(_id.updated_at).format('DD.MM.YY HH:mm:ss') : 'pending'
        }
      });

      res.json({ status: 'ok', checks: response });
    })
    .catch(next);
  });
};

module.exports.fetchWallet = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`fetchWallet - user:${userId}`);

  User.findById(userId)
  .exec( (err, _user) => {
    if (err) return next(err);
    if (!_user) return next(new Error('Unauthorized'));
    if (!_user.balance_locked) return res.json({ status: 'error', message: 'Balance not locked' });

    let todos = [];
    if (!_user.claim_setup) todos.push(_user.setupWallet());
    todos.push(Withdraw.FetchWithdrawRequests(userId));

    Promise.all(todos)
    .then((completedTodos) => {

      if (todos.length == 2) [setup, withdraws] = completedTodos
      if (todos.length == 1) [withdraws] = completedTodos

      User.findById(userId)
      .exec( (err, user) => {
        if (err) return next(err);

        let pendingBalance = 0;
        if (withdraws.length) {
          let pendingWithdraws = withdraws.filter((w) => {
            return (w.rejected === false && w.tx === '');
          });

          pendingBalance = pendingWithdraws.reduce((total, w) => total + w.amount, 0);
        }

        res.json({
          status:       'ok',
          claimAddress: user.claim_address,
          claimBalance: user.claim_balance,
          pendingBalance: pendingBalance,
          claimStatus:  user.claim_status,
          withdraws:    withdraws
        });
      });
    })
    .catch((err) => {
      debug(`Unable to fetchWallet - user:${userId}`);
      console.log(err);
      next(err);
    });
  });
}

module.exports.fetchWalletRequests = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`fetchWalletRequests - user:${userId}`);

  User.findById(userId)
  .exec( (err, _user) => {
    if (err) return next(err);
    if (!_user) return next(new Error('Unauthorized'));

    Withdraw.FetchWithdrawRequests(_user._id)
    .then((requests) => {
      res.json({
        status:       'ok',
        claimAddress: user.claim_address,
        claimBalance: user.claim_balance,
        claimStatus:  user.claim_status,
        withdraws:    requests
      });
    })
    .catch((err) => {
      debug(`Unable to fetchWalletRequests - user:${userId}`);
      console.log(err);
      next(err);
    });
  });
}

module.exports.walletWithdraw = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`walletWithdraw - user:${userId}`);

  User.findById(userId)
  .exec( (err, _user) => {
    if (err) return next(err);
    if (!_user) return next(new Error('Unauthorized'));

    let sendTo = escape_string(req.body['address']);
    let amount = Number(req.body['amount']);

    amount = Number(amount.toFixed(8));

    debug(`Requesting Withdraw - user:${userId}`);
    Withdraw.RequestWithdraw(_user, sendTo, amount)
    .then((withdrawRequest) => {
      debug(`Got Withdraw Request - user:${userId}`);

      return res.json({
        status: 'ok'
      });
    })
    .catch((err) => {
      return res.json({
        status: 'error',
        message: (err.message) ? err.message : 'rejected'
      });
    });
  });
}

module.exports.enableClaimLock = (req, res, next) => {
  debug('EnableClaimLock');

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  debug(`Enable Claim Lock - user:${userId}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) return next(err);
    if (!user) return next(new Error('Unauthorized'));
    
    if (user.balance_locked) return res.json({ status: 'error', message: 'claim_locked' });

    user.lockBalance()
    .then((locked) => {
      debug('Successfully locked');

      return res.json({ status: 'ok' });
    })
    .catch((err) => {
      if (err === 'lock_denied_time') {
        return res.json({ status: 'error', message: err });
      }
      else {
        next(err);
      }
    });
  });
}

// TODO: DRY
module.exports.changePassword = (req, res, next) => {
  debug('ChangePassword');

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;
  let jwtExp = (userDetails.exp || 0);

  debug(`Change User Password | user:${userId} , exp:${jwtExp}`);

  User.findById(userId)
  .exec( (err, user) => {
    if (err) return next(err);
    if (!user) return next(new Error('Unauthorized')); 
    
    let newPassword = req.body.password;
    let tfaCode     = req.body.tfaCode;

    if (user.tfa_enabled) {
      debug(`Change User Password, 2FA REQUIRED - user:${user.email}`);

      if (!tfaCode)
        return res.status(401).json({ status: 'error', tfa_enabled: true });

      user.authTFA(tfaCode)
      .then((success) => {
        debug(`Change User Password, 2FA ACCEPTED - user:${user.email}`);

        user.password = newPassword;
        user.save((err, savedUser) => {
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

          debug(`Change User Password, Password Updated - user:${savedUser.email}`);

          return res.json({ status: 'ok' });
        });
      })
      .catch((rejected) => {
        debug(`Change User Password, 2FA REJECTED - user:${user.email}`);

        return res.status(401).json({ status: 'error', tfa_enabled: true, tfa_rejected: true });
      });
    }
    else {
      debug(`Change User Password - user:${user.email}`);

      user.password = newPassword;
      user.save((err, savedUser) => {
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

        debug(`Change User Password, Password Updated - user:${savedUser.email}`);
        return res.json({ status: 'ok' });
      });
    }
  });
}

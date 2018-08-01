const passport = require('passport');
const mongoose = require('mongoose');
const User      = mongoose.model('User');
const debug     = require('debug')('odin-portal:controller:user');
const AuthIP    = mongoose.model('AuthIP');
const moment    = require('moment');
const metrics   = require('../lib/metrics');
const Raven     = require('raven');

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

module.exports.register = (req, res, next) => {
  debug(`Register User - ${req.body.email}`);

  let user = new User({
    email:              req.body.email,
    password:           req.body.password,
    wallet:             req.body.walletAddress,
    termsAccepted:      req.body.termsAccepted,
    email_verified:     false,
    wallet_verified:    true
  });

  user.save((err) => {
    if (err) {
      debug(`Register User Error - ${req.body.email}`);
      Raven.captureMessage('Register User Error', {
        level: 'info',
        extra: err
      });
      
      return res.json({ status: 'error', error: err });
    }

    AuthIP.saveActivity(user._id, req.ip)
    .then((authIp) => debug('Confirmed AuthIp saved'))
    .catch((err) => {
      debug('Confirmed AuthIp issue');
    });

    metrics.measurement('registration', req.body.timestampDiff);

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
      })
    });
    
  });
};

module.exports.login = (req, res) => {
  debug(`Login User - ${req.body.email}`);

  passport.authenticate('local', (err, user, info) => {
    // If Passport throws/catches an error
    if (err) {
      debug(`Login Error - ${req.body.email}`);
      Raven.captureMessage('User Login Error', {
        level: 'info',
        extra: err
      });
      return res.status(404).json({ status: 'error', error: err });
    }

    // If a user is found
    if (user) {
      AuthIP.saveActivity(user._id, req.ip)
      .then((authIp) => debug('Confirmed AuthIp saved'))
      .catch((err) => {
        debug('Confirmed AuthIp issue');
      });

      debug(`Login Accepted - ${req.body.email}`);

      user.refreshBalance()
      .then((_userRefresh) => {
        let token = _userRefresh.generateJwt();
        
        return res.json({ status: 'ok', token: token });
      });
    }
    else {
      debug(`Login Rejected - ${req.body.email} - ${(info.message) ? info.message : 'Unknown'}`);
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

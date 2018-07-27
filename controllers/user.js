const passport = require('passport');
const mongoose = require('mongoose');
const User      = mongoose.model('User');
const debug     = require('debug')('odin-portal:controller:user');
const AuthIP    = mongoose.model('AuthIP');
const moment    = require('moment');

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

module.exports.register = (req, res) => {
  debug(`Register User - ${req.body.email}`);

  console.log(req.body);

  let user = new User({
    email:              req.body.email,
    password:           req.body.password,
    wallet:             req.body.walletAddress,
    termsAccepted:      req.body.termsAccepted,
    privacyAccepted:    req.body.privacyAccepted,
    email_verified:     false,
    wallet_verified:    true
  });

  user.save((err) => {
    if (err) {
      debug(`Register User Error - ${req.body.email}`);
      console.log(err);
      return res.json({ status: 'error', error: err });
    }

    AuthIP.saveActivity(user._id, req.ip)
    .then((authIp) => debug('Confirmed AuthIp saved'))
    .catch((err) => {
      console.log('ERRRRRRR');
      console.log(err);
      debug('Confirmed AuthIp issue');
    });

    let token = user.generateJwt();
    user.requireEmailValidation()
    .then((sendGridResult) => {
      console.log('EMAIL VALIDATION SENT');
      return res.json({ status: 'ok', token: token });
    })
    .catch((err) => {
      console.log('EMAIL VALIDATION ERROR', err);
      return res.json({ status: 'ok', token: token });
    })
  });
};

module.exports.login = (req, res) => {
  debug(`Login User - ${req.body.email}`);

  passport.authenticate('local', (err, user, info) => {
    // If Passport throws/catches an error
    if (err) {
      debug(`Login Error - ${req.body.email}`);
      return res.status(404).json({ status: 'error', error: err });
    }

    // If a user is found
    if (user) {
      AuthIP.saveActivity(user._id, req.ip)
      .then((authIp) => debug('Confirmed AuthIp saved'))
      .catch((err) => {
        console.log('ERRRRRRR');
        console.log(err);
        debug('Confirmed AuthIp issue');
      });

      debug(`Login Accepted - ${req.body.email}`);
      let token = user.generateJwt();
      return res.json({ status: 'ok', token: token });
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

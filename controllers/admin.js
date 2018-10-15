const passport      = require('passport');
const mongoose      = require('mongoose');
const User          = mongoose.model('User');
const debug         = require('debug')('odin-portal:controller:admin');
const AuthIP        = mongoose.model('AuthIP');
const Flag          = mongoose.model('Flag');
const Request       = mongoose.model('Request');
const Withdraw      = mongoose.model('Withdraw');
const Notification  = mongoose.model('Notification');
const Identity      = mongoose.model('Identity');
const moment        = require('moment');
const metrics       = require('../lib/metrics');
const Raven         = require('raven');

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

module.exports.updateUser = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User.findById(userId)
  .exec((err, user) => {
    if (err) {
      debug(`Unable to find user ${userId}`);
      console.log(err);
      return next(err);
    }

    if (user.level !== 'admin')
      return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

    let updateEmail = escape_string(req.body['email']);
    let updatedParams = req.body['updatedParams'];

    debug('POST MESSAGE');
    debug(req.body);

    User.UpdateUserProperty(updateEmail, updatedParams)
    .then(() => {
      res.json({ status: 'ok' });
    })
    .catch(next);
  });
};

module.exports.updateIdentity = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User.findById(userId)
  .exec((err, user) => {
    if (err) {
      debug(`Unable to find user ${userId}`);
      console.log(err);
      return next(err);
    }

    if (user.level !== 'admin')
      return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

    let identityReference = escape_string(req.body['reference']);
    let identityStatus = escape_string(req.body['status']);

    Identity.UpdateStatus(identityReference, identityStatus)
    .then(() => {
      res.json({ status: 'ok' });
    })
    .catch(next);
  });
};

module.exports.search = (req, res, next) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User.findById(userId)
  .exec((err, user) => {
    if (err) {
      debug(`Unable to find user ${userId}`);
      console.log(err);
      return next(err);
    }

    if (user.level !== 'admin')
      return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });
    
    let searchEmail = escape_string(req.body['email']);
    if (!searchEmail)
      return res.json({ status: 'ok', result: false });

    searchEmail = `${searchEmail}`.toLowerCase().trim();
    debug(`Search For User - '${searchEmail}'`);

    User.findOne({ email: searchEmail })
    .exec((err, _matchedUser) => {
      if (err) {
        debug(`Unable to find user ${userId}`);
        console.log(err);
        return next(err);
      }

      if (!_matchedUser) return res.json({ status: 'ok', result: false });

      let pulledDetails = [];
      pulledDetails.push(Flag.FindByUser(_matchedUser));
      pulledDetails.push(Withdraw.FindByUser(_matchedUser));
      pulledDetails.push(Identity.FindByUser(_matchedUser));

      Promise.all(pulledDetails)
      .then(([ flags, withdraws, identities ]) => {
        console.log('TOTALS', {
          flags: flags.length,
          withdraws: withdraws.length,
          identities: identities.length
        });

        _matchedUser = {
          email:                _matchedUser.email,
          wallet:               _matchedUser.wallet,
          claimStatus:          _matchedUser.claim_status,
          identityStatus:       _matchedUser.identity_status,
          isBalanceLocked:      _matchedUser.balance_locked,
          lockedBalanceTotal:   _matchedUser.balance_locked_sum,
          totalClaim:           _matchedUser.claim_calculated,
          claimBalance:         _matchedUser.claim_balance,
          createdOn:            moment(_matchedUser.created_at).format('YYYY-MM-DD HH:mm:ss'),
          totalFlags:           flags.length,
          is2FAEnabled:         _matchedUser.tfa_enabled,
          isAllowLateLock:      _matchedUser.allow_late_lock
        };

        return res.json({
          status: 'ok',
          result: {
            user:       _matchedUser,
            flags:      flags,
            withdraws:  withdraws,
            identities: identities
          }
        });
      })
      .catch((err) => {
        debug('Unable to pull user');
        console.log(err);
        next(err);
      });
    });
  });
};

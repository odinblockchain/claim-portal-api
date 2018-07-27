const passport = require('passport');
const mongoose = require('mongoose');
const User = mongoose.model('User');
const Request = mongoose.model('Request');
const debug     = require('debug')('odin-portal:controller:request');

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

module.exports.sample = (req, res) => {
  debug(`Sample -- ${req.body.address}`);
  return res.json({ status: 'ok', message: 'foo' });
};

module.exports.verifyEmailCode = (req, res) => {
  debug(`Request Verify Email Code -- ${req.body.code}`);

  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User
  .findById(userId)
  .exec(((err, user) => {
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
        let token = updatedUser.generateJwt();
        return res.json({ status: 'ok', token: token });
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
  }));
};

module.exports.verifyEmailHex = (req, res) => {
  debug(`Request Verify Email Hex -- ${req.body.code}`);
  
  Request.validateWithoutAuth(req.body.type, req.body.code)
  .then((request) => {
    let user = request.user;

    Promise.all([ request.user.validateEmail(), Request.removeRequestsByType(user._id, req.body.type) ])
    .then( ([ updatedUser, emailRequestsRemoved ]) => {
      let token = updatedUser.generateJwt();
      return res.json({ status: 'ok', token: token });
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

const express   = require('express');
const mongoose  = require('mongoose');
const settings  = require('../../config/');
const db        = require('../../lib/database');
const debug     = require('debug')('odin-portal:routes:alert');
const router    = express.Router();
const SiteAlert = mongoose.model('SiteAlert');
const User      = mongoose.model('User');
const jwt       = require('express-jwt');
const auth      = jwt({
  secret: settings.secret,
  userProperty: 'payload'
});

function parseUserAuthHeader(req) {
  try {
    let authToken = req.headers['authorization'].split(' ');
    let token = authToken[1].split('.')[1];
    let buff = Buffer.from(token, 'base64').toString('binary');
    // console.log('BUFF', buff);
    
    return JSON.parse(buff);
  } catch (err) {
    debug('Unable to parseUserAuthHeader');
    console.log(err);
    return '';
  }
}

router.get('/', (req, res) => {
  SiteAlert.findOne({}, {}, { sort: { 'createdAt' : -1 } })
  .exec((err, alert) => {
    if (err) {
      console.log(err);
      return res.json({
        status: 'error',
        error: err,
        api: req.app.locals.version
      });
    }

    if (!alert) {
      console.log(err);
      return res.json({
        status: 'ok',
        alert: {},
        api: req.app.locals.version
      });
    }

    // console.log(alert);
    return res.json({
      status: 'ok',
      alert: alert.formatted(),
      api: req.app.locals.version
    });
  });
});

router.post('/', auth, (req, res) => {
  let userDetails = parseUserAuthHeader(req);
  if (!userDetails.auth || !userDetails.exp)
    return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });

  let userId = userDetails.auth;

  User.findById(userId)
  .exec( (err, user) => {
    if (user.level !== 'admin') {
      debug('Alert Set REJECTED -- Unauthorised');
      return res.status(401).json({ status: 'error', message: 'Request Unauthorised' });
    }

    let alert = SiteAlert({
      type: req.body.type,
      title: req.body.title,
      message: req.body.message,
      enabled: req.body.enabled,
      lastEditBy: user._id
    });
  
    alert.save((err) => {
      if (err) {
        debug('Alert Set REJECTED -- Unknown');
        return res.status(401).json({ status: 'error', message: 'Request Rejected' });
      }

      return res.json({ status: 'ok' })
    });
  });
});

module.exports = router;

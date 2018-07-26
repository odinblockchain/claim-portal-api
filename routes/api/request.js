const express   = require('express');
const mongoose  = require('mongoose');
const User      = require('../../models/User');
const Identity  = require('../../models/Identity');
const AuthIP    = require('../../models/AuthIP');
const settings  = require('../../config/');
const db        = require('../../lib/database');
const debug     = require('debug')('odin-portal:routes:request');
const router    = express.Router();
const jwt       = require('express-jwt');
const auth      = jwt({
  secret: settings.secret,
  userProperty: 'payload'
});

const RequestController = require('../../controllers/request');

router.post('/verify', auth, RequestController.verifyEmailCode);
router.post('/verifyEmail', RequestController.verifyEmailHex);

/**
 * Catch UnauthorizedErrors
 */
router.use(function (err, req, res, next) {
  if (err.name === 'UnauthorizedError') {
    debug(`UnauthorizedError : ${(err.message) ? err.message : '???'}`)
    res.status(401);
    res.json({ status: 'error', message: `${err.name}:${err.message}` });
  }
});

module.exports = router;

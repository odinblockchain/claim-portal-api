const express   = require('express');
const mongoose  = require('mongoose');
const User      = require('../../models/User');
const Identity  = require('../../models/Identity');
const AuthIP    = require('../../models/AuthIP');
const settings  = require('../../config/');
const db        = require('../../lib/database');
const debug     = require('debug')('odin-portal:routes:api');
const router    = express.Router();
const ApiController = require('../../controllers/api');

// import API routes
const userRouter = require('./user');
const authRouter = require('./auth');
const requestRouter = require('./request');

// custom validator objects
let ValidationError = mongoose.Error.ValidationError;
let ValidatorError  = mongoose.Error.ValidatorError;

// router.use('/admin', authUtil.verifySessionId, authUtil.verifyLisencee);
// router.post('/admin', controllerIndex.ads.adListingAdmin);

router.get('/', (req, res, next) => {
  res.json({ status: 'ok', version: req.app.locals.version });
});

router.use((err, req, res, next) => {
  debug('MIDDLEWARE');
  console.log('body', req.body);
  next()
});

// general API routes
router.post('/validateSignature', ApiController.validateSignature);

// implement API routes
router.use('/user', userRouter);
router.use('/auth', authRouter);
router.use('/request', requestRouter);

// error handlers
// Catch unauthorised errors
router.use(function (err, req, res, next) {
  debug('caught error');
  console.log(err);
  if (err.name === 'UnauthorizedError') {
    res.status(401);
    res.json({ status: 'error', message: `${err.name}:${err.message}` });
  }
});

module.exports = router;

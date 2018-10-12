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
const identityRouter = require('./identity');
const authRouter = require('./auth');
const requestRouter = require('./request');
const metricsRouter = require('./metrics');
const alertRouter = require('./alert');
const adminRouter = require('./admin');
// const eventRouter = require('./event'); // TODO Better Event Metrics

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

router.get('/countryCodes', (req, res, next) => {
  let commonCodes   = ['BR', 'CN', 'FR', 'DE', 'IN', 'IR', 'JP', 'RU', 'ES', 'GB', 'US'];
  let countryCodes  = req.app.locals.countryCodes;
  let commonCountries = countryCodes.filter(country => (commonCodes.indexOf(country.shortCode) !== -1));

  res.json({
    status: 'ok',
    commonCodes: commonCountries,
    countryCodes: req.app.locals.countryCodes
  });
});

// implement API routes
router.use('/user', userRouter);
router.use('/admin', adminRouter);
router.use('/identity', identityRouter);
router.use('/auth', authRouter);
router.use('/request', requestRouter);
router.use('/metric', metricsRouter);
router.use('/alert', alertRouter);
// router.use('/event', eventRouter); // TODO Release Event Metrics

// error handlers
// Catch unauthorised errors
router.use(function (err, req, res, next) {
  if (err.name === 'UnauthorizedError') {
    res.status(401);
    res.json({ status: 'error', message: `${err.name}:${err.message}` });
  }
  else {
    debug('caught error');
    next(err);
  }
});

module.exports = router;

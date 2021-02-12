const express   = require('express');
const mongoose  = require('mongoose');
const Identity  = require('../../models/Identity');
const AuthIP    = require('../../models/AuthIP');
const settings  = require('../../config/');
const db        = require('../../lib/database');
const debug     = require('debug')('odin-portal:routes:metrics');
const router    = express.Router();
const User      = mongoose.model('User');
const Raven     = require('raven');

router.get('/claimAccounts', (req, res, next) => {
  User.countDocuments({})
  .exec((err, count) => {
    if (err) {
      debug(`Unable to count Users -- ${(err.message) ? err.message : ''}`);
      Raven.captureException(err, {
        tags: {
          route: 'metrics'
        }
      });
      return next(err);
    }

    res.json({
      status: 'ok',
      total: count
    });
  })
});

module.exports = router;

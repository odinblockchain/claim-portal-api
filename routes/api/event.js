const express   = require('express');
const mongoose  = require('mongoose');
const User      = require('../../models/User');
const Identity  = require('../../models/Identity');
const AuthIP    = require('../../models/AuthIP');
const settings  = require('../../config/');
const db        = require('../../lib/database');
const debug     = require('debug')('odin-portal:routes:event');
const router    = express.Router();

const metrics   = require('../../lib/metrics');

function on_error(err) {
  debug('STATSD Error');
  console.log((err.message) ? err.message : '');
}

router.get('/:measurement/:value', (req, res) => {
  res.json({
    measurement: req.params.measurement,
    value: req.params.value,
    tags: req.query
  });
  
});

router.get('/:measurement', (req, res) => {
  let tags = '';
  if (Object.keys(req.query).length) {
    tags = [];
    for (tag in req.query) {
      tags.push(`${tag}=${req.query[tag]}`);
    }

    tags = `,${tags.join(',')}`;
  }

  metrics.counter(req.params.measurement, tags);
  res.status(204).send();

  // let foo = metrics.increment(`claim_api.${req.params.measurement}${tags}`);
  // console.log(foo);

  // res.json({
  //   measurement: req.params.measurement,
  //   tags: req.query,
  //   str: `claim_api.${req.params.measurement}${tags}`
  // });
});

router.get('/', (req, res) => {
  timer = metrics.createTimer('claim_api.interval')
  metrics.set(`claim_api.sample`, 20);
  res.send('ok');
  setTimeout(function () {
    timer.stop();
  }, 2500);
});

/**
 * Catch UnauthorizedErrors
 */
router.use(function (err, req, res, next) {
  if (err.name === 'UnauthorizedError') {
    debug(`UnauthorizedError : ${(err.message) ? err.message : '???'}`)
    res.status(401);
    res.json({ status: 'error', message: `${err.name}:${err.message}` });
  }
  else {
    debug('error thrown');
    next(err)
  }
});

module.exports = router;

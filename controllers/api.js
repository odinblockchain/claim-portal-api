const passport  = require('passport');
const mongoose  = require('mongoose');
const User      = mongoose.model('User');
const debug     = require('debug')('odin-portal:controller:api');
const Raven     = require('raven');

module.exports.validateSignature = (req, res) => {
  debug(`Validating Signature -- ${req.body.address}`);

  User
  .findOne({ wallet: req.body.address })
  .exec((err, user) => {
    if (err) {
      console.log(`Signature Error -- ${req.body.address}`, err);
      Raven.captureException('Validate Signature Error', {
        level: 'error',
        tags: { metric: 'address_validation' },
        extra: {
          error: err
        }
      });

      return res.json({ status: 'error', message: 'server_error' });
    }

    if (user) {
      Raven.captureMessage('Validate Signature Duplicate', {
        level: 'info',
        tags: { metric: 'address_validation' },
        extra: {
          address: req.body.address
        }
      });

      return res.json({ status: 'error', message: 'duplicate' });
    }

    User.validateSignature(req.body.address, req.body.signed, req.body.message)
    .then((status) => {
      debug('VALID', status)
      res.json({ status: 'ok' });
    })
    .catch((err) => {
      console.log(`Signature Error -- ${req.body.address}`, err);
      return res.json({ status: 'error', message: (err.message) ? err.message : err.toLowerCase() });
    })
  });
};

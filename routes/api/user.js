const express   = require('express');
const mongoose  = require('mongoose');
const User      = require('../../models/User');
const Identity  = require('../../models/Identity');
const AuthIP    = require('../../models/AuthIP');
const settings  = require('../../config/');
const db        = require('../../lib/database');
const debug     = require('debug')('odin-portal:routes:api');
const router    = express.Router();
const jwt       = require('express-jwt');
const auth      = jwt({
  secret: settings.secret,
  userProperty: 'payload'
});

const UserController = require('../../controllers/user');

/**
 * POST   api/v1/user       -- Create new user
 * GET    api/v1/user/$id   -- Get user matching $id
 * DELETE api/v1/user/$id   -- Delete user matching $id
 * 
 * GET    api/v1/identity/$id   -- Get identity for matching user $id
 * DELETE api/v1/identity/$id   -- Delete identity for matching user $id
 * 
 * GET    api/v1/auth/$id   -- Get identity for matching user $id
 * DELETE api/v1/auth/$id   -- Delete identity for matching user $id
 * 
 * POST   api/v1/session    -- Create session for user (email/password)
 * DELETE api/v1/session    -- Delete session data for user (email/password)
 */

router.get('/profile', auth, UserController.userRead);
router.get('/fetchDetails', auth, UserController.fetchDetails);
router.post('/', UserController.register);

// router.get('/user', (req, res, next) => {
//   User.findOne({ email: 'email2@website.com' })
//   .populate('auth_ips')
//   .populate('identity')
//   .exec((err, user) => {
//     if (err) return res.json({ status: 'error', error: err });
//     res.json({ status: 'ok', user: user });
//   });
// });

// router.get('/identity', (req, res, next) => {
//   Identity.findOne({ user: '5b55ba12de7d801861b97f35' })
//   .populate('user')
//   .exec((err, identity) => {
//     if (err) return res.json({ status: 'error', error: err });
//     res.json({ status: 'ok', identity: identity });
//   });
// });

// router.get('/new', (req, res, next) => {
//   let user = new User({
//     name: 'FakeGuy',
//     password: 'FakePassword#!123',
//     email: 'email2@website.com'
//   });
  
//   user.save(function (err) {
//     if (err) return res.json({ status: 'error', error: err });
//     console.log('USER saved');

//     var authIP = new AuthIP({
//       user: user._id,
//       ip: '123.456.789.001'
//     });

//     authIP.save((err) => {
//       if (err) return res.json({ status: 'error', error: err });
//       console.log('AUTH SAVED');

//       var identity = new Identity({
//         user: user._id,
//         firstName: 'Fake',
//         lastName: 'Guy',
//         birthDate: '07-06-1993',
//         countryCode: 'US'
//       });

//       identity.save(function (err) {
//         if (err) return res.json({ status: 'error', error: err });
//         console.log('IDENTITY SAVED');
  
//         res.json({ status: 'ok', user: user, identity: identity, ip: authIP });
//       });
//     });
//   });
// });

// router.get('/', (req, res, next) => {
//   User.find().exec(function (err, results) {
//     var count = results.length
//     res.json({ status: 'ok', version: req.app.locals.version, users: count, sample: User.sample('lol') })
//   });
// });

module.exports = router;

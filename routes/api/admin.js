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

const AdminController = require('../../controllers/admin');

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

router.post('/search', auth, AdminController.search);
router.post('/updateUser', auth, AdminController.updateUser);
router.post('/updateIdentity', auth, AdminController.updateIdentity);

module.exports = router;

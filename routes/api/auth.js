const express   = require('express');
const mongoose  = require('mongoose');
const User      = require('../../models/User');
const Identity  = require('../../models/Identity');
const AuthIP    = require('../../models/AuthIP');
const settings  = require('../../config/');
const db        = require('../../lib/database');
const debug     = require('debug')('odin-portal:routes:api');
const router    = express.Router();

const UserController = require('../../controllers/user');

router.post('/', UserController.login);

module.exports = router;

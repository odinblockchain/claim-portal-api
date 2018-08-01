
const Address   = require('../models/Address');
const AuthIP    = require('../models/AuthIP');
const Identity  = require('../models/Identity');
const Request   = require('../models/Request');
const SiteAlert = require('../models/SiteAlert');
const User      = require('../models/User');
const settings  = require('../config/');
const mongoose  = require('mongoose');
const debug     = require('debug')('odin-portal:lib:database');

async function find_user_by_id(userId) {
  return new Promise((resolve, reject) => {
    User.findOne({ id: userId }, (err, user) => {
      if (err) return reject(err);
      if (user) return resolve(user);
      reject('user not found');
    });
  });
}

async function find_user_by_email(email) {
  return new Promise((resolve, reject) => {
    User.findOne({ email: email }, (err, user) => {
      if (err) return reject(err);
      if (user) return resolve(user);
      reject('user not found');
    });
  });
}

async function user_login_search(userParams) {
  return new Promise((resolve, reject) => {
    debug('Searching for user', userParams);
    User.findOne({ email: userParams.email, password: userParams.password }, (err, user) => {
      debug('login err', err);
      debug('user', user);
      if (err) return reject(err);
      if (user) return resolve(user);
      reject('user not found');
    });
  });
}

module.exports = {
  
  // initialize DB
  connect: async function(database) {
    return new Promise((res, rej) => {
      debug('Establishing database connection');

      mongoose.connect(database)
      .then(res)
      .catch((err) => {
        err.code = 'ECONNREFUSED';
        rej(err);
      });
    });
  },

  get_user_by_id: find_user_by_id,
  get_user_by_email: find_user_by_email,
  login_user: user_login_search
};

const mongoose    = require('mongoose');
const Schema      = mongoose.Schema;
const UserSchema  = require('./schema');

const settings  = require('../../config/');
const debug     = require('debug')('odin-portal:model:user');
const moment    = require('moment');
const bcrypt    = require('bcryptjs');
const owasp     = require('owasp-password-strength-test');

const jwt = require('jsonwebtoken');

/**
 * Schema Variables
 */
const SALT_WORK_FACTOR  = 10;
const ValidationError   = mongoose.Error.ValidationError;
const ValidatorError    = mongoose.Error.ValidatorError;

function validEmail(email) {
  var emailRegex1 = /^(([^<>()[\]\\.,;:\s@\"]+(\.[^<>()[\]\\.,;:\s@\"]+)*)|(\".+\"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;
  var emailRegex2 = /^(?:[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*|"(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21\x23-\x5b\x5d-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])*")@(?:(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?|\[(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?|[a-z0-9-]*[a-z0-9]:(?:[\x01-\x08\x0b\x0c\x0e-\x1f\x21-\x5a\x53-\x7f]|\\[\x01-\x09\x0b\x0c\x0e-\x7f])+)\])$/i;

  return emailRegex2.test(email);
};

function validPassword(password) {
  let pTest = owasp.test(password);
  if (pTest.errors.length > 0) {
    return pTest.errors.join(',');
  }
  else {
    return true;
  }
};

// UserSchema Static methods
require("./statics.js")(UserSchema);

// UserSchema Class methods
require("./methods.js")(UserSchema);

UserSchema.virtual('greeting').get(function() {
  return `Greetings ${this.name}!`;
});

UserSchema.virtual('created_at_full').get(function() {
  return moment(this.created_at).format('MMMM Do YYYY'); 
});

UserSchema.virtual('updated_at_full').get(function() {
  return moment(this.updated_at).format('MMMM Do YYYY'); 
});

// Remove password for toJSON to protect accidental password leaks
UserSchema.set('toJSON', {
  getters: true,
  transform: (doc, ret, options) => {
    delete ret.password;
    delete ret.xfa_secret;
    delete ret.xfa_secret_tmp;
    delete ret.id;
    delete ret['__v'];
    return ret;
  }
})


// Validate email prior to saving
UserSchema.pre('save', function(next) {
  let user = this;

  // only verify email if it has been modified (or is new)
  if (!user.isModified('email')) return next();

  if (!validEmail(this.email)) {
    var error = new ValidationError(this);
    error.errors.email = new ValidatorError({
      type: 'invalid',
      path: 'email',
      value: this.email
    });
    return next(error);
  }
  next();
});

// Validate password length prior to saving
UserSchema.pre('save', function(next) {
  let user = this;

  // only verify the password if it has been modified (or is new)
  if (!user.isModified('password')) return next();

  // check password length
  debug('Checking password length...');
  if (this.password.length === 0 || this.password === '') {
    var error = new ValidationError(this);
    error.errors.password = new ValidatorError({
      type: 'required',
      path: 'password',
      value: this.password
    });
    return next(error);
  }

  // test password strength
  debug('Checking password strength...');
  let pTest = owasp.test(user.password);
  if (pTest.errors.length > 0) {
    var error = new ValidationError(this);
    error.errors.password = new ValidatorError({
      type: 'insecure',
      path: 'password',
      value: '',
      message: pTest.errors.join(','),
      reason: pTest.errors.join(',')
    });
    return next(error);
  }

  next();
});

// Hash Password prior to saving
UserSchema.pre('save', function(next) {
  var user = this;

  // only hash the password if it has been modified (or is new)
  if (!user.isModified('password')) return next();

  // generate a salt
  debug('Hashing password...');
  bcrypt.genSalt(SALT_WORK_FACTOR, function(err, salt) {
    if (err) return next(err);

    // hash the password along with our new salt
    bcrypt.hash(user.password, salt, function(err, hash) {
      if (err) return next(err);

      debug(`Hashed password: ${user.password} = ${hash}`);

      // override the cleartext password with the hashed one
      user.password = hash;
      next();
    });
  });
});

UserSchema.pre('save', function(next) {
  this.updated_at = moment().utc();
  next();
});

UserSchema.post('save', function(error, doc, next) {
  if (error.name === 'MongoError' && error.code === 11000 && /email/ig.test(error.message)) {
    var error = new ValidationError(this);
    error.errors.email = new ValidatorError({
      type: 'duplicate',
      path: 'email',
      value: this.email
    });

    return next(error);
  } else {
    next(error);
  }
});

UserSchema.post('save', function(doc) {
  debug(`Record saved for USER#${doc.id} [${doc.email}] [${doc.updated_at}]`, doc);
});



UserSchema.pre('update', function(next) {
  this.update({}, { $set: {
    updated_at: moment().utc()
  }});

  next();
});

UserSchema.pre('update', function(next) {
  debug('PRE UPDATE -- CHECK NAME');
  console.log('post update time', this.getUpdate());

  try {
    let name = this.getUpdate().$set.name;
    if (!name) return next();

    try {
      console.log(`Before name: ${this.name}, new name: ${name}`);
      // const salt = Bcrypt.genSaltSync();
      // const hash = Bcrypt.hashSync(password, salt);
      // this.getUpdate().$set.password = hash;
      next();
    } catch (err) {
      return next(err);
    }
  } catch(err) {
    console.log(err);
    next();
  }
  

  // if (this.isModified('name')) {
  //   debug('>> NAME UPDATED');
  // }

  // console.log(`Password modified? ${this.isModified('password')}`);
  // console.log(`Name modified? ${this.isModified('name')}`);
  // console.log(`Email modified? ${this.isModified('email')}`);

  // next();
});

UserSchema.post('update', function(error, doc, next) {
  if (error.name === 'MongoError' && error.code === 11000 && /email/ig.test(error.message)) {
    var error = new ValidationError(this);
    error.errors.email = new ValidatorError({
      type: 'duplicate',
      path: 'email',
      value: this.email
    });

    return next(error);
  } else {
    debug(`Record saved for USER#${doc.id} [${doc.email}] [${doc.updated_at}]`, doc);
    next(error);
  }
});

module.exports = mongoose.model('User', UserSchema);

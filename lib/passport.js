const passport = require('passport');
const LocalStrategy = require('passport-local').Strategy;
const mongoose = require('mongoose');
const User = mongoose.model('User');

passport.use(new LocalStrategy({
  usernameField: 'email'
}, function(username, password, done) {
  User.findOne({ email: username }, function (err, user) {
    if (err) { return done(err); }
    
    // Return if user not found in database
    if (!user) {
      return done(null, false, {
        message: 'User not found'
      });
    }

    // Return if password is wrong
    user.validPassword(password)
    .then(() => {
      return done(null, user);
    })
    .catch((err) => {
      console.log('rejected password', err);
      return done(null, false, {
        message: 'Password is wrong'
      });
    });
  });
}));

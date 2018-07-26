const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;

/**
 * Schema for User Identities
 */
const IdentitySchema = new Schema({
  user: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },
  
  firstName: {
    type: String,
    default: ''
  },

  lastName: {
    type: String,
    default: ''
  },

  birthDate: {
    type: String,
    default: ''
  },

  countryCode: {
    type: String,
    default: ''
  }
});

module.exports = mongoose.model('Identity', IdentitySchema);

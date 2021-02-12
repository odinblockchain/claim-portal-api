const mongoose  = require('mongoose');
const Schema    = mongoose.Schema;
const moment    = require('moment');

/**
 * Schema for User Identities
 */
const SiteAlertSchema = new Schema({
  lastEditBy: {
    type: Schema.Types.ObjectId,
    ref: 'User'
  },

  type: {
    type: String,
    default: 'info'
  },

  title: {
    type: String,
    default: ''
  },

  message: {
    type: String,
    default: ''
  },

  enabled: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

SiteAlertSchema.virtual('datePosted').get(function() {
  // return this.created_at;
  return moment(this.createdAt).format('MMMM Do YYYY | HH:mm'); 
});

SiteAlertSchema.methods.formatted = function() {
  return {
    type: this.type,
    title: this.title,
    message: this.message,
    enabled: this.enabled,
    posted: this.datePosted
  };
};

module.exports = mongoose.model('SiteAlert', SiteAlertSchema);

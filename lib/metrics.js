const lynx      = require('lynx');
const settings  = require('../config/');
const debug     = require('debug')('odin-portal:lib:metrics');

const statsdConfig  = settings['integrations']['statsd'];
const metrics       = new lynx(statsdConfig.host, statsdConfig.port, { on_error: on_error });

function on_error(err) {
  debug('STATSD Error');
  console.log((err.message) ? err.message : '');
}

function formatTags(tags) {
  if (typeof tags === 'undefined') return '';
  if (typeof tags === 'string') return tags;
  if (!Object.keys(tags).length) return '';

  let formatted = '';
  formatted = [];
  for (tag in tags)
    formatted.push(`${tag}=${tags[tag]}`);

  return `,${formatted.join(',')}`;
}

module.exports = {
  counter: (measurement, tags) => {
    tags = formatTags(tags);
    metrics.increment(`claim_api.${measurement}${tags}`);

    debug('PUSH counter');
  },

  measurement: (measurement, value, tags) => {
    tags = formatTags(tags);
    metrics.gauge(`claim_api.${measurement}${tags}`, value);

    debug(`PUSH measurement claim_api.${measurement}${tags} = ${value}`)
  },

  error: (error, tags) => {
    return true;
    // tags = formatTags(tags);
    
    // metrics.increment(`claim_api.error${tags},error=${(error.message) ? error.message : error}`);
    // debug(`PUSH error claim_api.error${tags},error=${(error.message) ? error.message : error}`);
  },

  accountCreated: () => {

  }
}

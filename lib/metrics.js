const lynx      = require('lynx');
const settings  = require('../config/');
const debug     = require('debug')('odin-portal:lib:metrics');

const statsdConfig  = settings['integrations']['statsd'];
const metrics       = new lynx(statsdConfig.host, statsdConfig.port, { on_error: on_error });
const metricId      = settings['integrations']['statsd']['metric_id'];

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
    metrics.increment(`${metricId}.${measurement}${tags}`);

    debug(`PUSH counter ${metricId}.${measurement}${tags}`);
  },

  measurement: (measurement, value, tags) => {
    tags = formatTags(tags);
    metrics.gauge(`${metricId}.${measurement}${tags}`, value);

    debug(`PUSH measurement ${metricId}.${measurement}${tags} = ${value}`)
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

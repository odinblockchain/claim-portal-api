const package     = require('../package.json');
const db          = require('../lib/database');
const mongoose    = require('mongoose');
const Push        = mongoose.model('Push');
const User        = mongoose.model('User');
const PurgedUser  = mongoose.model('PurgedUser');
const AuthIP      = mongoose.model('AuthIP');
const Request     = mongoose.model('Request');
const settings    = require('../config/');
const debug       = require('debug')('odin-portal:script:handlePushRequests');
const metrics     = require('../lib/metrics');
const Raven       = require('raven');
const env         = process.env.NODE_ENV || 'development';
const moment      = require('moment');
const request     = require('request');
const Nexmo       = require('nexmo');

Raven.config(settings['integrations']['sentry']['DSN'], {
  release: package.version,
  environment: env
}).install();

let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

let availableNumbers  = settings['integrations']['nexmo']['numbers']; 
let activeNumber      = 0;

/**
 *  {
 *    'message-count': '1',
      messages: [
        {
          to: '13125506948',
          'message-id': '0B000000E170D22C',
          status: '0',
          'remaining-balance': '1.95860000',
          'message-price': '0.00570000',
          network: '310004'
        }
      ]
    }
*/

let handleResult = (sms, result, pushRequest) => {
  return new Promise((resolve, reject) => {

    if (result && Number(result.messages[0]['remaining-balance']) <= 3) {
      let balance = Number(result.messages[0]['remaining-balance']);
      debug(`TRIGGER WARNING -- Nexmo Balance LOW ${balance}`);
      Raven.captureMessage('SMS Nexmo Balance Low', {
        level: 'warning',
        logger: 'User.Methods.sendSMSAuth',
        extra: {
          balance: balance
        }
      });
    }

    if (result && result.messages[0].status == '0') {
      pushRequest.sent_timestamp = moment().utc();
      pushRequest.failed = false;
    }
    else {
      pushRequest.sent_timestamp = -1;
      pushRequest.failed = true;

      let errMessage = (result && result.error_text) ? result.error_text : 'NO_RESPONSE';
      debug(`SMS Failed :: ${errMessage}`);
      Raven.captureMessage('SMS Nexmo Failed', {
        level: 'error',
        logger: 'User.Methods.sendSMSAuth',
        extra: {
          sms: sms,
          result: result
        }
      });

      resolve(false);
    }

    pushRequest.save((err, _p) => {
      if (err) {
        debug(`Unable to save pushRequest`);
        Raven.captureMessage('SMS Push Request Save Failed', {
          level: 'error',
          logger: 'User.Methods.sendSMSAuth',
          extra: {
            sms: sms,
            err: err
          }
        });

        return resolve(false);
      }

      if (pushRequest.failed) return resolve(false);
      return resolve(true);
    });
  });
}

let attemptSMS = (fromNumber, pushRequest) => {
  return new Promise((resolve, reject) => {

    let nexmo = new Nexmo({
      apiKey:         settings['integrations']['nexmo']['key'],
      apiSecret:      settings['integrations']['nexmo']['secret']
    }, {
      debug: false
    });

    const from  = fromNumber;
    const to    = pushRequest.user.phoneNumber;
    const text  = pushRequest.message.substr(0, 120); // ensure message is a little under the limit (160)

    debug(`Sending SMS:
    from: ${from}
    to:   ${to}
    text: ${text}
    id:   ${pushRequest.user.claimId}`);

    let sms = {
      from: from,
      to: to,
      text: text,
      user: pushRequest.user.claimId,
    };

    nexmo.message.sendSms(from, to, text, (err, result) => {
      if (err) {
        debug('SMS Auth Request Err', err);
        return resolve(false);
      }

      setTimeout(()=> {
        debug('SMS Result', result);
        handleResult(sms, result, pushRequest)
        .then(resolve)
        .catch(reject);
      }, 2000);

      // activeNumber++;
      // if (activeNumber > (availableNumbers.length - 1)) {
      //   activeNumber = 0;
      //   debug(`THROTTLE... 2 seconds...`);
        
      //   setTimeout(() => {
      //     debug(`Continue`);
      //     handleResult(sms, result, pushRequest)
      //     .then(resolve)
      //     .catch(reject);
      //   }, 2000)
      // }
      // else {
        
      // }
    });
  });
};

const throttlep = n=> Ps=>
  new Promise ((pass, fail)=> {
    // r is the number of promises, xs is final resolved value
    let r = Ps.length, xs = []
    // decrement r, save the resolved value in position i, run the next promise
    let next = i=> x=> (r--, xs[i] = x, run(Ps[n], n++))
    // if r is 0, we can resolve the final value xs, otherwise chain next
    let run = (P,i)=> r === 0 ? pass(xs) : P().then(next(i), fail)
    // initialize by running the first n promises
    Ps.slice(0,n).forEach(run)
  })


db.connect(dbString)
.then(() => {

  // Fetch requests older than 1 minutes ago
  let matureRequests = moment().utc();
  matureRequests.subtract(30, 'seconds');

  Push.find({
    failed: false,
    sent_timestamp: 0
  })
  .where('requested_timestamp').lt(Number(matureRequests.format('x')))
  .populate('user')
  .exec((err, pushRequests) => {

    if (err) {
      console.log('Unable to perform Push Request Search');
      console.log(err);
      Raven.captureException('Handle Push Request Failure', {
        tags: { script: 'handlePushRequests' },
        extra: {
          error: err
        }
      });

      return setTimeout(() => {
        process.exit(1);
      }, 5000);
    }

    debug(`Handle Push Requests
    Time now:       ${moment().utc().format('YYYY-MM-DD HH:mm:ss x')}
    Looking for: <= ${matureRequests.format('YYYY-MM-DD HH:mm:ss x')}
    Total ready:    ${pushRequests.length}`);

    if (!pushRequests.length) {
      return process.exit(0);
    }

    // console.log(requests);
    let todos = pushRequests.map((request) => {
      let from = availableNumbers[activeNumber];
      activeNumber++;
      if (activeNumber > (availableNumbers.length - 1)) activeNumber = 0;

      return attemptSMS(from, request);
    });

    Promise.all(todos)
    .then((results) => {
      let success = results.filter(r => (r === true)).length;
      let fail = results.filter(r => (r === false)).length;

      console.log('Push Request Complete');

      debug(`[ Results ]
      Successful Updates: ${success}
      Failed Updates: ${fail}`);

      setTimeout(() => {
        process.exit(0);
      }, 2000);
    })
    .catch((err) => {
      console.log('Unable to perform Push Requests');
      console.log(err);
      Raven.captureException('Handle Push Request Resolve Issues', {
        tags: { script: 'handlePushRequests' },
        extra: {
          error: err
        }
      });

      return setTimeout(() => {
        process.exit(1);
      }, 5000);
    });
  });
})
.catch((err) => {
  console.log('Unable to perform Push Requests');
  console.log(err);
  Raven.captureException('Handle Push Request Resolve Issues', {
    tags: { script: 'handlePushRequests' },
    extra: {
      error: err
    }
  });

  return setTimeout(() => {
    process.exit(1);
  }, 5000);
});


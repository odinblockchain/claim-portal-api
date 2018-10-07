const package     = require('../package.json');
const db          = require('../lib/database');
const mongoose    = require('mongoose');
const Withdraw    = mongoose.model('Withdraw');
const User        = mongoose.model('User');
const PurgedUser  = mongoose.model('PurgedUser');
const AuthIP      = mongoose.model('AuthIP');
const Request     = mongoose.model('Request');
const settings    = require('../config/');
const debug       = require('debug')('odin-portal:script:handleWithdrawRequests');
const metrics     = require('../lib/metrics');
const Raven       = require('raven');
const env         = process.env.NODE_ENV || 'development';
const moment      = require('moment');
const request     = require('request');

Raven.config(settings['integrations']['sentry']['DSN'], {
  release: package.version,
  environment: env
}).install();

let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;


let attemptWithdraw = (fromAccount, toAddress, amount, withdrawRequest) => {
  return new Promise((resolve, reject) => {
    let uri     = `${settings.apiHost}/api/blockchain/sendfrom`;
    let params  = {
      fromaccount:  fromAccount,
      toaccount:    toAddress,
      amount:       amount
    };

    if (withdrawRequest.user.claim_status !== 'approved') {
      debug(`Attempting Withdraw: BLOCKED, user not approved
      from:   ${fromAccount}
      to:     ${toAddress}
      amount: ${amount}`);

      withdrawRequest.rejected = true;
      withdrawRequest.sent_timestamp = -1;
      withdrawRequest.tx = -1;

      return withdrawRequest.save((err, _w) => {
        if (err) {
          console.log('UNABLE TO SAVE WITHDRAW REQUEST');
          return reject(new Error('Cannot save withdraw request'));
        }

        return resolve(true);
      });
    }

    debug(`Attempting Withdraw:
    from:   ${fromAccount}
    to:     ${toAddress}
    amount: ${amount}`);

    let username = settings['coind_auth']['client'];
    let password = settings['coind_auth']['secret'];
    let auth = `Basic ${new Buffer(username + ":" + password).toString("base64")}`;

    request({ uri: uri, qs: params, headers: { 'Authorization': auth } }, (err, response, body) => {
      debug(`API RESPONSE
      error:    ${(err) ? err.message : ''},
      response: ${(response) ? response.statusCode : ''},
      body:     ${(typeof body === 'object') ? JSON.stringify(body) : body}
      typeof:   ${typeof body}
      `);

      if (err || response.statusCode !== 200) {
        debug(`FAILED Withdraw:
        body:   ${body}
        error:  ${err}`);

        withdrawRequest.rejected = true;
        withdrawRequest.sent_timestamp = -1;
        withdrawRequest.tx = -1;

        Raven.captureException('Withdraw Failed', {
          level: 'error',
          extra: {
            error: err,
            body: body,
            statusCode: response.statusCode,
            withdrawRequest: {
              user: withdrawRequest.user,
              from: withdrawRequest.from,
              to: withdrawRequest.to,
              amount: withdrawRequest.amount
            }
          }
        });
      }
      else if (response.statusCode === 200) {
        if (/insufficient/ig.test(body)) {
          withdrawRequest.rejected = true;
          withdrawRequest.sent_timestamp = -1;
          withdrawRequest.tx = -1;
        }
        else if (body.length === 64) {
          withdrawRequest.rejected = false;
          withdrawRequest.sent_timestamp = moment().utc();
          withdrawRequest.tx = body;

          withdrawRequest.user.claim_balance = (withdrawRequest.user.claim_balance - amount);
        }
      }


      withdrawRequest.save((err, _w) => {
        if (err) {
          console.log('UNABLE TO SAVE WITHDRAW REQUEST');
          return reject(new Error('Cannot save withdraw request'));
        }

        withdrawRequest.user.save((err, _u) => {
          if (err) {
            console.log('UNABLE TO SAVE WITHDRAW REQUEST USER');
            return reject(new Error('Cannot save withdraw request user'));
          }

          return resolve(true);
        });
      });
    });
  });
}


db.connect(dbString)
.then(() => {

  // Fetch requests older than 5 minutes ago
  let matureRequests = moment().utc();
  matureRequests.subtract(5, 'm');

  Withdraw.find({
    rejected: false,
    tx: ''
  })
  .where('requested_timestamp').lt(Number(matureRequests.format('x')))
  .populate('user')
  .exec((err, requests) => {
    if (err) {
      console.log('Unable to perform Withdraw Search');
      console.log(err);
      Raven.captureException('Handle Withdraw Request Failure', {
        tags: { script: 'handleWithdrawRequests' },
        extra: {
          error: err
        }
      });

      return setTimeout(() => {
        process.exit(1);
      }, 5000);
    }

    debug(`Handle Withdraw Requests
    Time now:       ${moment().utc().format('YYYY-MM-DD HH:mm:ss x')}
    Looking for: <= ${matureRequests.format('YYYY-MM-DD HH:mm:ss x')}
    Total ready:    ${requests.length}`);

    // console.log(requests);
    let todos = requests.map((request) => {
      return attemptWithdraw(request.user.claimId, request.to, request.amount, request);
    });

    Promise.all(todos)
    .then((results) => {
      debug('RESULTS', results);

      return setTimeout(() => {
        process.exit(1);
      }, 1000);
    })
    .catch((err) => {
      console.log('Unable to perform Withdraws');
      console.log(err);
      Raven.captureException('Handle Withdraw Request Resolve Issues', {
        tags: { script: 'handleWithdrawRequests' },
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
  console.log('Unable to perform Withdraw Search');
  console.log(err);
  Raven.captureException('Handle Withdraw Request Connection Loss', {
    tags: { script: 'handleWithdrawRequests' },
    extra: {
      error: err
    }
  });

  return setTimeout(() => {
    process.exit(1);
  }, 5000);
});


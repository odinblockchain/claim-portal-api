const express     = require('express');
const router      = express.Router();

// Switched to old bitcoin npm module due to getrawtransaction duplicate key issue
// const bitcoinCore = require('bitcoin-core');
const bitcoin     = require('bitcoin');

// Default accessible methods (simple read-only requests)
let defaultAccessMethods = [
  'getInfo',
  'getMiningInfo'
];

// Check if a method key exists within a methodList
function methodAvailable(method, methodList) {
  if (typeof methodList !== 'object') methodList = defaultAccessMethods;

  let regexExists = new RegExp(methodList.join("|"), 'gi');
  if (method.match(regexExists)) return true
  return false;
}

// Determine if a uri component needs to be decoded
function containsEncodedComponents(x) {
  return (decodeURI(x) !== decodeURIComponent(x));
}


/**
 * Router :: Middleware Funnel
 */

// Setup request.coind properties
router.use((req, res, next) => {
  req.coindClient   = {};
  req.coindCommand  = {
    method:     req.path.substring(1,req.path.length),
    parameters: []
  };
  
  next();
});

// Verify method is allowed)
router.use((req, res, next) => {
  if (req.coindCommand['method'] === '') {
    next(new Error('missing_blockchain_method'));
  }
  else if ( !methodAvailable(req.coindCommand['method'], req.app.get('coindAllowedMethods')) &&
            !methodAvailable(req.coindCommand['method'], req.app.get('coindSecureMethods'))
  ) {
    next(new Error(`invalid_blockchain_method (${req.coindCommand['method']})`));
  }
  else {
    next();
  }
});

// Verify credentials if secure method
router.use((req, res, next) => {
  if (methodAvailable(req.coindCommand['method'], req.app.get('coindSecureMethods'))) {
    let auth = req.headers['authorization'];
    if (!auth) return next(new Error(`authentication_required (${req.coindCommand['method']})`));

    let tmp = auth.split(' ');
    let buf = new Buffer(tmp[1], 'base64');
    let plain_auth = buf.toString();

    let creds = plain_auth.split(':');
    let username = creds[0];
    let password = creds[1];

    let authKeys = req.app.get('coindAuth');
    if (!authKeys) return next(new Error(`improper_authentication_setup`));
    if (!authKeys.hasOwnProperty('client')) return next(new Error(`improper_authentication_setup`));
    if (!authKeys.hasOwnProperty('secret')) return next(new Error(`improper_authentication_setup`));

    if ( !((username == authKeys.client) && (password == authKeys.secret)) ) {
      return next(new Error(`authentication_invalid (${req.coindCommand['method']})`));
    }
    else {
      next();
    }
  }
  else {
    next();
  }
});

// Clean up any passed parameters
router.use((req, res, next) => {
  if (Object.keys(req.query).length === 0) return next();

  let coindParams = [];
  for (let param in req.query) {
    if (req.query.hasOwnProperty(param)) {
      let pValue = req.query[param];
      pValue = (containsEncodedComponents(pValue)) ? decodeURIComponent(pValue) : pValue;

      if (typeof pValue  === 'undefined' || pValue === '') continue;
      if (!isNaN(pValue)) pValue = parseFloat(pValue);
      coindParams.push(pValue);
    }
  }

  req.coindCommand['parameters'] = coindParams;
  next();
});

// Setup bitcoin-client for RPC communication
router.use((req, res, next) => {
  if (typeof req.app.get('coindRPCSettings') === 'undefined') {
    next(new Error('missing_coind_blockchain_settings'));
  }
  else {
    req.coindClient = new bitcoin.Client(req.app.get('coindRPCSettings'));
    next();
  }
});

// Handle Request
router.get('*', (req, res, next) => {
  if (typeof req.coindClient['cmd'] !== 'function')
    return next(new Error('invalid_coind_client'));

  let command = [{
    method: req.coindCommand['method'],
    params: req.coindCommand['parameters']
  }];

  req.coindClient.cmd(command, (err, response) => {

    if (err) {
      err = (err.message) ? err.message : err;
      console.log(`\nRPC_ERROR :: ${req.url}\n${JSON.stringify(req.coindCommand)}\nError: ${err}\n`);
      
      if (err.match(/status code.*401/g))
        return next(new Error('Wallet Authentication Error (401 Unauthorized)'));
      return next(new Error(err));
    }

    if (typeof response === 'object') {
      if (response.hasOwnProperty('name') && response['name'] === 'RpcError') {
        console.log(`\nRPC_ERROR :: ${req.url}\n${JSON.stringify(req.coindCommand)}\n${response['message']}\n`);
        return next(new Error(`rpc_error`));
      }
      return res.json(response);
    }
    
    res.send('' + response);
  });
});

module.exports = router;

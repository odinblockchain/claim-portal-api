/**
 * Dependencies
 */
const package         = require('./package.json');
const createError     = require('http-errors');
const cors            = require('cors');
const corsConfig      = require('./config/cors');
const express         = require('express');
const path            = require('path');
const cookieParser    = require('cookie-parser');
const logger          = require('morgan');
const coindApi        = require('xxl-coind-express-api');
const debug           = require('debug')('odin-portal:app');
const session         = require('express-session');
const settings        = require('./config/');
const passport        = require('passport');
const db              = require('./lib/database');
const passportConfig  = require('./lib/passport');
const env             = process.env.NODE_ENV || 'development';
const redis           = require('redis');
const redisStore      = require('connect-redis')(session);
const redisClient     = redis.createClient({
  host: settings.dbSession.host,
  port: settings.dbSession.port
});

// Create list of countries
let countries    = require('country-data').countries;
let countryCodes = [];
Object.values(countries).filter(c => !!(c.status === 'assigned')).forEach(element => {
  let codeIndex = countryCodes.findIndex(c => !!(c.name == element.name));
  // if (codeIndex !== -1)
    // console.log('SKIPPING', element.name, codeIndex);
  // else
  if (codeIndex === -1)
    countryCodes.push({ name: element.name, code: element.alpha2 });
});

// map((c) => {
//   return { name: c.name, code: c.alpha2 };
// });

// var uniqEs6 = (arrArg) => arrArg.filter((elem, pos, arr) => arr.indexOf(elem) == pos)
// countryCodes = uniqEs6(countryCodes);

// console.log(countries);

// console.log('before', Object.values(countries).length);
// console.log(countryCodes);
// console.log('after', countryCodes.length);

// console.log(require('country-data').regions);

/**
 * App setup
 */
var app = express();

/**
 * App Local Vars
 */
app.locals.countryCodes = countryCodes;
app.locals.version = package.version;

/**
 * Setup Mongoose (MongoDB) Connection
 */
let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
dbString = dbString + '@' + settings.dbsettings.address;
dbString = dbString + ':' + settings.dbsettings.port;
dbString = dbString + '/' + settings.dbsettings.database;

db.connect(dbString)
.then(() => debug('Connected to MongoDB'))
.catch((err) => console.log(err));

/**
 * Constants
 */
const MS_HOUR = 3600000;

/**
 * Routes
 */
// const indexRouter     = require('./routes/index');
// const usersRouter     = require('./routes/users');
// const kycRouter       = require('./routes/kyc');
const apiRouter = require('./routes/api');

/**
 * Production Only Redirects (www & https)
 */
if (env === 'production') {
  app.use(function(req, res, next) {
    if (req.headers.host.slice(0, 4) === 'www.') {
      let newHost   = req.headers.host.slice(4);
      return res.redirect(301, 'https://' + newHost + req.originalUrl);
    }

    next();
  });

  app.use(function(req, res, next) {
    if (!req.secure)
      return res.redirect('https://' + req.get('Host') + req.originalUrl);
    
    next();
  });
}

/**
 * Set Options
 */
app.options('*', cors());

/**
 * Set View Engine
 */
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

/**
 * Set Middleware
 */

app.use(corsConfig);

// Hit logging
app.use(logger(':status :method :url :res[content-length] - :response-time ms'));

// Parse JSON POST
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Setup xxl-coind-express middleware
let allowedMethods = ['verifymessage'];
let walletSettings = settings.wallet;

app.set('coindAllowedMethods', allowedMethods);
app.set('coindRPCSettings', walletSettings); 
app.use('/api/blockchain', coindApi);

// nginx.conf: proxy_set_header  X-Real-IP  $remote_addr;
app.enable('trust proxy');

// Parse Cookies
app.use(cookieParser());

// Setup Redis Session store
app.use(session({
  name: 'opAuth',
  resave: false,
  saveUninitialized: false,
  secret: settings.secret,
  maxAge: 14 * 24 * MS_HOUR,
  store: new redisStore({
    host: settings.dbSession.host,
    port: settings.dbSession.port,
    client: redisClient,
    ttl: 14 * 24 * MS_HOUR
  }),
  cookie: {
    maxAge: 14 * 24 * MS_HOUR
  }
}));

// static files
app.use(express.static(path.join(__dirname, 'public')));

// bind routes
// app.use('/', indexRouter);
// app.use('/account', usersRouter);
// app.use('/kyc', kycRouter);

app.use(passport.initialize());
app.use('/api/v1', apiRouter);


// 404 middleware
app.use(function(req, res, next) {
  console.log(`${req.path} 404 Error -- Portal ${req.OdinUser}`)
  next(createError(404));
});

// error middleware
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.json({ status: 'error', message: (err.message) ? err.message : 'sever error occurred' });
});

module.exports = app;

// (async function(portalApp) {
//   // Configure database connection
//   let dbString = 'mongodb://' + encodeURIComponent(settings.dbsettings.user);
//   dbString = dbString + ':' + encodeURIComponent(settings.dbsettings.password);
//   dbString = dbString + '@' + settings.dbsettings.address;
//   dbString = dbString + ':' + settings.dbsettings.port;
//   dbString = dbString + '/' + settings.dbsettings.database;

//   return await new Promise((res, rej) => {
//     db.connect(dbString)
//     .then(() => {
//       console.log('Connected to MongoDB');
//       res(portalApp);
    
//       // server.listen(port);
//       // server.on('error', onError);
//       // server.on('listening', onListening);
//     })
//     .catch(rej);
//   })

// Connect to datba

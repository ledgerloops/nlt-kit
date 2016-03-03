require('babel-polyfill');

const environment = {
  development: {
    isProduction: false
  },
  production: {
    isProduction: true
  }
}[process.env.NODE_ENV || 'development'];

module.exports = Object.assign({
  host: process.env.CLIENT_HOST,
  port: process.env.CLIENT_PORT,
  apiHost: process.env.API_HOSTNAME,
  apiPort: process.env.API_PORT,
  ledgerUriPrivate: process.env.API_LEDGER_URI_PRIVATE || process.env.API_LEDGER_URI,
  app: {
    title: 'Five Bells Ledger UI',
    description: 'UI for creating accounts and sending money on five bells ledger',
    meta: {
      charSet: 'utf-8'
    }
  },
  public: {
    sentryUri: process.env.SENTRY_URI
  }
}, environment);

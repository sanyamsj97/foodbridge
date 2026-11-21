'use strict';
const config = require('./config');
const { createApp } = require('./app');
const { sweepExpired } = require('./services/donations');

const app = createApp();
app.listen(config.port, () => {
  console.log(`FoodBridge running on ${config.appUrl} (port ${config.port}, db=${config.dbDriver}, env=${process.env.NODE_ENV || 'development'})`);
});

// Expire uncollected donations whose deadline / safe time has passed.
setInterval(() => sweepExpired().catch((e) => console.error('sweep failed', e.message)), config.sweepIntervalMs).unref();
sweepExpired().catch(() => {});

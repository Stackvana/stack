// rateLimiter/index.js

/*

  HTTP Plugin responsible for rate-limiting requests based on recorded usage metrics

  The rateLimiter plugin expects a 'provider' option is passed into it's configuration for storing usage metrics
  This provider will default to an in-memory, but can easily be extended to use Redis by passing in a Redis client

  The rateLimiter 'provider' requires the following methods:

    provider.hincrby
    provider.hget
    provider.hset

  If you are using a redis client or the build-in memory store as the provider, these methods should already available.

  By default, Rate-limiting information is sent back to the client request with the following HTTP headers:

  X-RateLimit-Limit - Total amount of requests processed during current period
  X-RateLimit-Remaining - Amount of requests remaining during current period
  X-RateLimit-Running - Total amount of currently running services ( current concurrency count )
  TODO: X-RateLimit-Concurrency - Amount of concurrency supported by this request
  TODO: X-RateLimit-Reset - Estimated time concurrency will reset

*/

/*

    Usage Metric Formats

    There are currently three unique metric reports ( hashes ) that we are tracking on each request.

    1. The system usage report, contains global stats for system. This is used primarily for admins or system-wide dashboards.

    var systemReport = {
      running: 40,
      totalHits: 10000000000
    };

    2. The user usage report, contains stats for single user. This is used to track service plan limits per user.
    var userReport = {
      running: 8,
      hits: 10000,
      totalHits: 400000
    };

    3. The service usage report, contains stats for single service. This is used to help track the state of an individual service.
    var serviceReport = {
      running: 4,
      hits: 1000,
      totalHits: 40000,
      lastRun: new Date(),
      lastCompleted: new Date(),
      lastStatusCode: 200
    }

*/

var Store = require('../Store');

function RateLimiter (config) {
  var self = this;
  config = config || {};
  // provider should be an instance of a node-redis client
  self.provider = config.provider || new Store('memory', 'Rate-Limiter');
  return self;
}

RateLimiter.prototype.registerService = function (data, cb) {
  var self = this;
  cb = cb || function () {};
  var serviceReportKey = '/' + data.owner + '/' + data.name + '/report';
  self.provider.hset(serviceReportKey, 'totalHits', 0, function (err) {
    cb(err);
  });
};

RateLimiter.prototype.removeService = function (data, cb) {
  var self = this;
  cb = cb || function () {};
  var serviceReportKey = '/' + data.owner + '/' + data.name + '/report';
  self.provider.del(serviceReportKey, function (err) {
    cb(err);
  });
};

// TODO: rate limiter needs to be constructed instance in order to support instance methods for register / remove 

RateLimiter.prototype.middle = function rateLimitingMiddleware (config) {
  var self = this;
  var provider = self.provider;

  config.maxLimit = config.maxLimit || 1000;
  config.maxConcurrency = config.maxConcurrency || 2;

  config.maxConcurrencyMessage = 'Rate limited: Max concurrency limit hit: ' + config.maxConcurrency;
  config.maxLimitMessage = 'Rate limited: Max services limit hit: ' + config.maxLimit;

  return function rateLimitingHandler (req, res, next) {

    // TODO: better default identity provider, perhaps get user name from system
    var owner = req.params.owner || 'anonymous';
    var hook = req.params.hook || req.url.replace('/', '');

    var now = new Date();
    var systemKey = '/system/report';
    var userKey = '/' + owner + '/report';
    var serviceKey = '/' + owner + '/' + hook;
    var serviceReportKey = '/' + owner + '/' + hook + '/report';
    var monthlyHitsKey = 'monthlyHits - ' + (now.getMonth() + 1) + '/' + now.getFullYear();

    function incrementHits (cb) {
      //
      // Remark: node-redis client should be able to pipeline these requests automatically since they are started from the same context
      //         We could consider using client.multi() to improve performance

      //
      // System metrics
      //
      // sorted set for containing total top hits and running ( useful for tracking active services and users )
      provider.zincrby(['hits', 1, owner]);
      provider.zincrby(['running', 1, owner]);

      //
      // Update Service Usage Report
      //
      // how many of this service is running
      provider.hincrby(serviceReportKey, 'running', 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      // last time this service was started
      provider.hset(serviceReportKey, 'lastStart', new Date().getTime(), function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });
      req._lastStart = new Date().getTime();

      // total times this service was run
      provider.hincrby(serviceReportKey, 'totalHits', 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      // monthlyHits
      provider.hincrby(serviceReportKey, monthlyHitsKey, 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      //
      // Update User Usage Report
      //

      // how many of this service is running
      var userKey = '/' + owner + '/report';
      provider.hincrby(userKey, 'running', 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
        // most important metric, must wait for result
        cb();
      });

      // total hits user has accumlated
      provider.hincrby(userKey, 'totalHits', 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      // total monthly hits user has accumlated
      provider.hincrby(userKey, monthlyHitsKey, 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      //
      // Update System Report with new stats
      //

      // total running services on system
      provider.hincrby(systemKey, 'running', 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      // total hits system has accumlated
      provider.hincrby(systemKey, 'totalHits', 1, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });
    }

    function incrementRunning (res, val) {
      provider.hincrby(userKey, 'running', val, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });
      provider.hincrby(systemKey, 'running', val, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      let recentKey = 'recent';
      if (res.statusCode === 500) {
        recentKey += ':500';
      }

      provider.zadd(recentKey, new Date().getTime(), serviceKey, function (err) {
        if (err) {
          return console.log('error: saving metrics/recent', serviceKey, err);
        }
      });

      //
      // update service report properties ( such as last known statusCode, lastTime, lastEnd )
      //
      provider.hincrby(serviceReportKey, 'running', val, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      provider.hset(serviceReportKey, 'lastEnd', new Date().getTime(), function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      provider.hset(serviceReportKey, 'lastTime', new Date().getTime() - req._lastStart, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });

      provider.hset(serviceReportKey, 'statusCode', res.statusCode, function (err) {
        if (err) {
          return console.log('error: saving metrics', serviceReportKey);
        }
      });
      provider.zincrby(['running', val, owner]);
    }

    res.on('close', function(){
      // console.log("res.close".magenta, res.statusCode);
      if (req.reduceCount === false) {
        // do nothing
      } else {
        // provider.zincrby(['running', -1, owner]);
        // decrement running total for user, system, and service reports
        incrementRunning(res, -1);
      }

    });

    res.on('finish', function(){
      // console.log("res.finish".magenta, res.statusCode);
      if (req.reduceCount === false) {
        // do nothing
      } else {
        // decrement running total for user, system, and service reports
        incrementRunning(res, -1);
      }
    });

    res.setHeader('X-RateLimit-Limit', config.maxLimit);

    // get monthly usage from user metric report
    provider.hget(userKey, monthlyHitsKey, function (err,  monthlyHits) {
      monthlyHits = monthlyHits || 0;
      provider.hget(serviceReportKey, 'totalHits', function (err,  totalHits) {
        if (totalHits === null || typeof totalHits === 'undefined') {
          req.reduceCount = false;
          // TODO: use callback with new error
          console.log('error: will not route unregistered service ' + serviceKey);
          var error = new Error('Will not route unregistered service: ' + serviceKey);
          error.code = 'UNREGISTERED_SERVICE';
          // Remark: Rely on calling function to handle http status and response after rate limit event
          return next(error);
        }

        // if total hits for user account is exceeded, rate-limit
        if (Number(monthlyHits) >= config.maxLimit) {
          res.setHeader('X-RateLimit-Remaining', '0');
          req.reduceCount = false;
          var error = new Error('Rate Limit Exceeded!');
          error.code = 'RATE_LIMIT_EXCEEDED';
          error.currentMonthlyHits = monthlyHits;
          error.monthlyLimit = config.maxLimit;
          return incrementHits(function(){
            next(error);
          });
        }

        res.setHeader('X-RateLimit-Remaining', (config.maxLimit -  monthlyHits).toString());

        // Get total amount of running hooks for current user
        // get currently running from user metric report
        provider.hget(userKey, 'running', function (err, totalRunning) {
          if (err) {
            return res.end(err.message);
          }
          if (totalRunning === null) {
            totalRunning = 0;
          }
          res.setHeader('X-RateLimit-Running', totalRunning.toString());
          // console.log('metric.' + owner + '.running'.green, total, config.maxConcurrency)
          // if total running is greater than account concurrency limit, rate-limit the request
          if (Number(totalRunning) >= config.maxConcurrency) {
            req.reduceCount = false;
            var error = new Error('Rate Concurrency Exceeded!');
            error.currentTotalRunning = totalRunning;
            error.maxConcurrency = config.maxConcurrency;
            error.code = 'RATE_CONCURRENCY_EXCEEDED';
            // Remark: Rely on calling function to handle http status and response after rate limit event
            return next(error);
          }

          return incrementHits(function(){
            next();
          });

        });

      });
    });
  };
};

module.exports = RateLimiter;

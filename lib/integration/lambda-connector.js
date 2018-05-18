'use strict'

// Optional require('dataloader')
let DataLoader
try {
  // eslint-disable-next-line global-require
  DataLoader = require('dataloader')
} catch (e) {
  // Fail silently
}

// Helper function
function isObjectLike(value) {
  return typeof value === 'object' && value !== null
}

// As dataloader-key is an object, we need to convert the event to canonical JSON-string
const objectCacheKeyFn = key => {
  if (isObjectLike(key)) {
    return JSON.stringify(Object.keys(key).sort().reduce((acc, val) => {
      acc[val] = key[val]  // eslint-disable-line no-param-reassign
      return acc
    }, {}))
  }
  return key
}

class LambdaConnector {
  constructor({ lambdaRunner, funcConfig, logger } = {}) {
    this.lambdaRunner = lambdaRunner
    this.funcConfig = funcConfig
    this.logger = logger

    this.loaderBatched = new DataLoader(this.fetchBatch.bind(this), {
      cacheKeyFn: objectCacheKeyFn,
    })
    this.loaderSingle = new DataLoader(this.fetch.bind(this), {
      batch: false,
      cacheKeyFn: objectCacheKeyFn,
    })
  }

  fetchBatch(events) {
    // lambdaRunner.invoke() returns a promise
    return this.lambdaRunner.invoke(this.funcConfig, events, this.logger)
  }

  fetch(events) {
    return Promise.all(
      events.map((event) =>
        // lambdaRunner.invoke() returns a promise
        this.lambdaRunner.invoke(this.funcConfig, event, this.logger)
      )
    )
  }

  invoke(event) {
    return this.loaderSingle.load(event)
  }

  invokeBatch(event) {
    return this.loaderBatched.load(event)
  }
}

module.exports = LambdaConnector

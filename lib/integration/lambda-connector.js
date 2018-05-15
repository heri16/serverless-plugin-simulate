'use strict'

const DataLoader = require('dataloader')

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

    this.loaderBatched = new DataLoader(this.fetchBatched.bind(this), {
      cacheKeyFn: objectCacheKeyFn,
    })
    this.loaderCacheOnly = new DataLoader(this.fetchSingle.bind(this), {
      batch: false,
      cacheKeyFn: objectCacheKeyFn,
    })
  }

  fetchSingle(events) {
    return Promise.all(
      events.map((event) =>
        // lambdaRunner.invoke() returns a promise
        this.lambdaRunner.invoke(this.funcConfig, event, this.logger)
      )
    )
  }

  fetchBatched(events) {
    return this.lambdaRunner.invoke(this.funcConfig, events, this.logger)
  }

  invoke(event) {
    return this.loaderCacheOnly.load(event)
  }

  invokeBatch(event) {
    return this.loaderBatched.load(event)
  }
}

module.exports = LambdaConnector

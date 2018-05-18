
'use strict'

// const createInput = require('./context/input')
const createUtil = require('./context/util')

const createFromRequest = (parentObj, args, identity, { headers }) => {
  const util = createUtil()

  return {
    context: {
      arguments: args,
      source: parentObj,
      identity,
      request: {
        headers,
      },
    },
    util,
    utils: util,
  }
}

const createFromResult = (result, parentObj, args, identity, { headers }) => {
  const util = createUtil()

  return {
    context: {
      arguments: args,
      source: parentObj,
      result,
      identity,
      request: {
        headers,
      },
    },
    util,
    utils: util,
  }
}

module.exports = {
  createFromRequest,
  createFromResult,
}

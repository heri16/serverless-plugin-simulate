
'use strict'

// const createInput = require('./context/input')
const createUtil = require('./context/util')

const createFromRequest = (request, identity, parentObj, args) => {
  const util = createUtil()

  return {
    context: {
      request,
      identity,
      source: parentObj,
      arguments: args,
    },
    util,
    utils: util,
  }
}

const createFromResult = (result, request, identity, parentObj, args) => {
  const util = createUtil()

  return {
    context: {
      result,
      request,
      identity,
      source: parentObj,
      arguments: args,
    },
    util,
    utils: util,
  }
}

module.exports = {
  createFromRequest,
  createFromResult,
}

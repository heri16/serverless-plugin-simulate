'use strict'

const BbPromise = require('bluebird')

const velocityContext = require('./velocity/context-appsync')
const velocityRenderer = require('./velocity/renderer')

class LambdaMapper {
  constructor({ connector, mapping: { requestMappingTemplate, responseMappingTemplate } }) {
    this.connector = connector

    this.requestMappingTemplate = requestMappingTemplate
    this.responseMappingTemplate = responseMappingTemplate
  }

  getRequestTemplateOutput(parent, args, identity, request) {
    const template = this.requestMappingTemplate

    if (!template) throw new Error('No velocity template is set')

    const context = velocityContext.createFromRequest(request, identity, parent, args)

    const output = velocityRenderer.render(template, context)

    try {
      return JSON.parse(output)
    } catch (err) {
      if (err instanceof SyntaxError) {
        err.message = `Velocity template does not render valid Json. ${err.message}`
      }
      throw err
    }
  }

  getResponseTemplateOutput(result, parent, args, identity, request) {
    const template = this.responseMappingTemplate

    if (!template) throw new Error('No velocity template is set')

    const context = velocityContext.createFromResult(result, request, identity, parent, args)

    const output = velocityRenderer.render(template, context)

    try {
      return JSON.parse(output)
    } catch (err) {
      if (err instanceof SyntaxError) {
        err.message = `Velocity template does not render valid Json. ${err.message}`
      }
      throw err
    }
  }

  resolve(parent, args, context, info) {  // eslint-disable-line no-unused-vars
    const httpRequest = context.req
    const identity = context.identity || {}

    // console.log(info)  // eslint-disable-line no-console

    return BbPromise.resolve()
      .then(() => this.getRequestTemplateOutput(parent, args, identity, httpRequest))
      .then(output => {
        if (output.version === '2017-02-28') {
          if (output.operation === 'BatchInvoke') {
            return this.connector.invokeBatch(output.payload)
          } else if (output.operation === 'Invoke') {
            return this.connector.invoke(output.payload)
          }
          throw new Error('Invalid operation in template')
        }
        throw new Error('Unknown template version')
      })
      .then(result => this.getResponseTemplateOutput(result, parent, args, identity, httpRequest))
  }
}

module.exports = LambdaMapper

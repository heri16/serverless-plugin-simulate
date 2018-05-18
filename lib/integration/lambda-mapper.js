'use strict'

// const fs = require('fs')

const BbPromise = require('bluebird')

const velocityContext = require('./velocity/context-appsync')
const velocityRenderer = require('./velocity/renderer')

class LambdaMapper {
  constructor({
    connector,
    fileLoader,
    mapping: { requestMappingTemplate, responseMappingTemplate },
  }) {
    this.connector = connector
    this.fileLoader = fileLoader

    // fileLoader.load() is not called here as we want lazy-loading
    this.requestMappingTemplatePath = requestMappingTemplate
    this.responseMappingTemplatePath = responseMappingTemplate
  }

  get requestMappingTemplate() {
    // Defer loading of template file until when required
    if (!this.requestMappingTemplatePath) throw new Error('No velocity template is set')
    // return BbPromise.resolve(fs.readFileSync(this.requestMappingTemplatePath, 'utf8'))
    return this.fileLoader.load(this.requestMappingTemplatePath)
  }

  get responseMappingTemplate() {
    // Defer loading of template file until when required
    if (!this.responseMappingTemplatePath) throw new Error('No velocity template is set')
    // return BbPromise.resolve(fs.readFileSync(this.responseMappingTemplatePath, 'utf8'))
    return this.fileLoader.load(this.responseMappingTemplatePath)
  }

  getRequestTemplateOutput(parent, args, identity, httpRequest) {
    return this.requestMappingTemplate
      .then((template) => {
        const context = velocityContext.createFromRequest(parent, args, identity, httpRequest)

        return velocityRenderer.render(template, context)
      })
      .then(JSON.parse)
      .catch((err) => {
        if (err instanceof SyntaxError) {
          const path = this.requestMappingTemplatePath
          // eslint-disable-next-line no-param-reassign
          err.message = `Velocity template ${path} does not render valid JSON. ${err.message}`
        }
        throw err
      })
  }

  getResponseTemplateOutput(result, parent, args, identity, httpRequest) {
    return this.responseMappingTemplate
      .then((template) => {
        const context = velocityContext.createFromResult(
          result, parent, args, identity, httpRequest
        )

        return velocityRenderer.render(template, context)
      })
      .then(JSON.parse)
      .catch((err) => {
        if (err instanceof SyntaxError) {
          const path = this.responseMappingTemplatePath
          // eslint-disable-next-line no-param-reassign
          err.message = `Velocity template ${path} does not render valid JSON. ${err.message}`
        }
        throw err
      })
  }

  resolve(parent, args, context, info) {  // eslint-disable-line no-unused-vars
    const httpRequest = context.req
    const identity = context.identity || {}

    // return a Promise
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

'use strict'

const fs = require('fs')
const path = require('path')

const BbPromise = require('bluebird')

// Optional require('dataloader')
let DataLoader
try {
  // eslint-disable-next-line global-require
  DataLoader = require('dataloader')
} catch (e) {
  // Fail silently
}

// Optional require('graphql-tools')
let makeExecutableSchema
try {
  // eslint-disable-next-line global-require
  ({ makeExecutableSchema } = require('graphql-tools'))
} catch (e) {
  // Fail silently
}

function objectToArrayWithNameProp(obj) {
  return Object.entries(obj).map(([key, item]) =>
    Object.assign({ name: key }, item)
  )
}

const LambdaConnector = require('./integration/lambda-connector')
const LambdaMapper = require('./integration/lambda-mapper')

const velocityDefaults = require('./integration/velocity/defaults')

const JSON_CONTENT_TYPE = 'application/json'

const normalizeProjectName = (name) => name && name.toLowerCase().replace(/[^a-z0-9]/g, '')

const getFunctionConfig = (serverless, functionName, functionConfig) => {
  const dist = serverless.service.custom &&
    serverless.service.custom.simulate &&
    serverless.service.custom.simulate.dist
  const distPath = dist ? `/${dist}` : ''

  const servicePath = serverless.config.servicePath
  const serviceName = serverless.service.service
  const provider = serverless.service.provider
  const stage = provider.stage
  const projectName = serverless.service.custom &&
    serverless.service.custom.simulate &&
    serverless.service.custom.simulate.services &&
    serverless.service.custom.simulate.services.projectName

  return Object.freeze({
    key: `${serviceName}-${stage}-${functionName}`,
    serviceName,
    servicePath,
    distPath,
    projectName: normalizeProjectName(projectName),
    region: provider.region,
    stage,
    functionName,
    handler: functionConfig.handler,
    memorySize: functionConfig.memorySize || provider.memorySize,
    timeout: functionConfig.timeout || provider.timeout,
    runtime: functionConfig.runtime || provider.runtime,
    environment: Object.assign(
      {},
      provider.environment || {},
      functionConfig.environment || {}
    ),
  })
}

const getAuthorizerName = (http) => {
  if (typeof http.authorizer === 'object') {
    return http.authorizer.name
  }

  if (typeof http.authorizer === 'string' && http.authorizer.trim().length > 0) {
    return http.authorizer
  }

  return null
}

// TODO: Support cross-service authorizers locally
const getAuthorizerConfig = (functions, http) => {
  const authorizerName = getAuthorizerName(http)
  if (!authorizerName) return null
  const identitySource = http.authorizer.identitySource || 'method.request.header.Authorization'

  const authorizerFunction = functions[authorizerName]

  if (!authorizerFunction) throw new Error(`Cannot find authorizer with name ${authorizerName}`)

  return Object.freeze({
    name: authorizerName,
    identitySource,
    function: authorizerFunction.config,
  })
}


const getDefaultConfig = (method) => {
  const headers = [
    'Content-Type',
    'X-Amz-Date',
    'Authorization',
    'X-Api-Key',
    'X-Amz-Security-Token',
  ]

  const cors = {
    origins: ['*'],
    methods: ['OPTIONS'],
    headers,
    allowCredentials: false,
  }

  cors.methods.push(method.toUpperCase())

  return Object.freeze(cors)
}

const getConfigFromSettings = (method, corsOptions) => {
  const cors = {
    origins: corsOptions.origins || ['*'],
    methods: corsOptions.methods || [],
    allowCredentials: Boolean(corsOptions.allowCredentials),
  }

  if (corsOptions.headers) {
    if (!Array.isArray(corsOptions.headers)) {
      throw new Error('CORS header values must be provided as an array.')
    }

    cors.headers = corsOptions.headers
  }

  if (cors.methods.indexOf('OPTIONS') === -1) {
    cors.methods.push('OPTIONS')
  }

  if (cors.methods.indexOf(method.toUpperCase()) === -1) {
    cors.methods.push(method.toUpperCase())
  }

  return Object.freeze(cors)
}

const getCorsConfig = (method, cors) => {
  if (!cors) return null

  return typeof cors === 'object' ? getConfigFromSettings(method, cors) : getDefaultConfig(method)
}

const getHttpConfig = (functions, http) => {
  const authorizer = getAuthorizerConfig(functions, http)
  const cors = getCorsConfig(http.method, http.cors)

  const config = Object.assign(
    { integration: 'lambda-proxy' },
    http,
    {
      path: `/${http.path}`,
      authorizer,
      cors,
    }
  )

  if (config.integration === 'lambda') {
    const requestTemplateSettings = http.request ? http.request.template : {
      'application/json': velocityDefaults.JSON_REQUEST_TEMPLATE,
    }

    config.requestTemplates = Object.assign(
      {
        '*/*': requestTemplateSettings[JSON_CONTENT_TYPE],
      },
      requestTemplateSettings
    )

    if (http.response) {
      const statusCodes = Object.keys(http.response.statusCodes || {})

      // eslint-disable-next-line arrow-body-style
      const defaultStatusCode = statusCodes.reduce((statusCode, settings) => {
        return settings.pattern ? settings.statusCode : statusCode
      }, 200)

      const defaultResponse = {
        statusCode: defaultStatusCode,
        headers: http.response.headers,
        template: http.response.template,
        pattern: '',
      }

      config.responseMappings = statusCodes.reduce((accum, statusCode) => {
        const response = http.response.statusCodes[statusCode]

        if (statusCode.pattern) {
          accum.push({
            statusCode,
            headers: response.headers,
            template: response.template,
            pattern: response.pattern,
          })
        }

        return accum
      }, [defaultResponse])
    } else {
      config.responseMappings = velocityDefaults.RESPONSE_STATUS_CODE
    }
  }

  return Object.freeze(config)
}

const getAppsyncDatasources = (serverless) => {
  const appSyncConfig = serverless.service.custom.appSync
  const dataSources = objectToArrayWithNameProp(appSyncConfig.dataSources)
  const region = serverless.service.provider.region
  // const awsResult = serverless.service.custom.appSync.awsResult

  return dataSources.map((ds) => {
    let config
    switch (ds.type) {
      case 'AWS_LAMBDA':
        config = {
          lambdaConfig: {
            lambdaFunctionArn: ds.config.lambdaFunctionArn,
            lambdaFunctionName: ds.config.lambdaFunctionName || null,
          },
        }
        break
      case 'AMAZON_DYNAMODB':
        config = {
          dynamodbConfig: {
            awsRegion: region,
            tableName: ds.config.tableName,
          },
        }
        if (ds.config.useCallerCredentials) {
          Object.assign(config, {
            useCallerCredentials: ds.config.useCallerCredentials,
          })
        }
        break
      case 'AMAZON_ELASTICSEARCH':
        config = {
          elasticsearchConfig: {
            awsRegion: region,
            endpoint: ds.config.endpoint,
          },
        }
        break
      case 'NONE':
        config = {}
        break
      default:
        this.serverless.cli.log('Data Source Type not supported', ds.type)
    }
    const dataSource = {
      // apiId: awsResult.graphqlApi.apiId,
      name: ds.name,
      type: ds.type,
      description: ds.description,
      serviceRoleArn: (ds.config && ds.config.serviceRoleArn) || '',
    }
    Object.assign(dataSource, config)
    return dataSource
  })
}

const getAppsyncMappings = (serverless) => {
  const config = serverless.service.custom.appSync
  const mappingTemplatesLocation = config.mappingTemplatesLocation || 'mapping-templates'
  const mappingTemplates = config.mappingTemplates || []
  // const awsResult = serverless.service.custom.appSync.awsResult

  return mappingTemplates.map((tpl) => {
    const requestMappingTemplate = `${mappingTemplatesLocation}/${tpl.request}`
    const responseMappingTemplate = `${mappingTemplatesLocation}/${tpl.response}`

    // If file does not exist, create from default template
    fs.writeFile(
      requestMappingTemplate,
      velocityDefaults.AWS_LAMBDA_REQUEST_MAPPING_TEMPLATE,
      { flag: 'wx' },
      (err) => !err
    )
    fs.writeFile(
      responseMappingTemplate,
      velocityDefaults.AWS_LAMBDA_RESPONSE_MAPPING_TEMPLATE,
      { flag: 'wx' },
      (err) => !err
    )

    return {
      // apiId: awsResult.graphqlApi.apiId,
      dataSourceName: tpl.dataSource,
      typeName: tpl.type,  // "Query"
      fieldName: tpl.field,  // "books"
      requestMappingTemplate,
      responseMappingTemplate,
    }
  })
}

const genericGraphqlResolver = (parent, args, context, info) => {
  if (!context[info.parentType] || !context[info.parentType][info.fieldName]) {
    throw new Error(`Cannot find resolver for ${info.parentType}: ${info.fieldName}`)
  }
  // Get mapper from context that were added by GraphqlFunc for every request
  const mapper = context[info.parentType][info.fieldName]
  return mapper.resolve(parent, args, context, info)
}

const getAppsyncSchema = (serverless, mappings) => {
  const servicePath = serverless.config.servicePath
  const config = serverless.service.custom.appSync
  const schemaPath = path.join(servicePath, config.schema || 'schema.graphql')
  const schemaTypeDefs = fs.readFileSync(schemaPath, 'utf8')

  const schemaResolvers = mappings.reduce((accum, mp) => {
    // eslint-disable-next-line no-param-reassign
    accum[mp.typeName] = accum[mp.typeName] || {}
    // eslint-disable-next-line no-param-reassign
    accum[mp.typeName][mp.fieldName] = genericGraphqlResolver
    return accum
  }, {})

  return makeExecutableSchema({
    typeDefs: schemaTypeDefs,
    resolvers: schemaResolvers,
  })
}

const getGraphqlFunc = (serverless) => {
  const datasources = getAppsyncDatasources(serverless)
  const mappings = getAppsyncMappings(serverless)
  const graphqlSchema = getAppsyncSchema(serverless, mappings)

  // Attach lambdaFunctionConfig to datasource with lambdaFunctionName attribute
  for (const datasource of datasources.filter(ds => ds.lambdaConfig)) {
    if (datasource.lambdaConfig.lambdaFunctionName) {
      // Local Lambda Function
      const functionName = datasource.lambdaConfig.lambdaFunctionName
      const functionConfig = serverless.service.getFunction(functionName)
      datasource.lambdaFunctionConfig = getFunctionConfig(serverless, functionName, functionConfig)
    } else {
      // TODO: Remote Lambda Function
    }
  }

  // Create a per-server DataLoader for reading & caching file contents
  const fileLoader = new DataLoader((filePaths) => (
    BbPromise.all(
      filePaths.map((filePath) =>
        BbPromise.promisify(fs.readFile)(filePath, 'utf8')
      )
    )
  ))

  // Watch for file changes across all mapping templates
  for (const mp of mappings) {
    const mpFilepaths = [mp.requestMappingTemplate, mp.responseMappingTemplate]
    for (const filepath of mpFilepaths) {
      // console.log(`Watching file ${filepath}`)
      // eslint-disable-next-line no-unused-vars
      fs.watch(filepath, { persistent: false }, (eventType, filename) => {
        // console.log(`Clearing file cache of ${filename}`)
        fileLoader.clear(filepath)
      })
    }
  }

  // This function will be invoked on every GraphQL request
  const graphqlFunc = (lambdaRunner) => (req) => {
    // Create a per-request context
    const context = {
      req,
      identity: { username: 'default' },
    }

    // IMPORTANT: Do not reuse same connector across different request (by different users)
    // Initialize new connectors for each request
    for (const datasource of datasources.filter(ds => ds.lambdaFunctionConfig)) {
      const connector = new LambdaConnector({
        lambdaRunner,
        funcConfig: datasource.lambdaFunctionConfig,
        logger: req.logger,
      })
      for (const mp of mappings.filter(m => m.dataSourceName === datasource.name)) {
        context[mp.typeName] = context[mp.typeName] || {}
        context[mp.typeName][mp.fieldName] = new LambdaMapper({
          connector,
          fileLoader,
          mapping: mp,
        })
      }
    }

    return {
      schema: graphqlSchema,
      context,
      // other options here:
      tracing: true,
      cacheControl: true,
      // a function applied to the parameters of every invocation of runQuery
      //formatParams?: Function,
      // a function applied to each graphQL execution result
      //formatResponse?: Function
    }
  }

  return graphqlFunc
}

const getFunctions = (serverless) => serverless.service.getAllFunctions().reduce((accum, name) => {
  const functionConfig = serverless.service.getFunction(name)

  accum[name] = { // eslint-disable-line no-param-reassign
    config: getFunctionConfig(serverless, name, functionConfig),
    events: functionConfig.events,
  }

  return accum
}, {})

const getFunction = (serverless, name) =>
  serverless.service.getAllFunctions().reduce((accum, funcName) => {
    if (name !== funcName) return accum

    const functionConfig = serverless.service.getFunction(name)

    return { // eslint-disable-line no-param-reassign
      config: getFunctionConfig(serverless, name, functionConfig),
      events: functionConfig.events,
    }
  }, null)

const getEndpoints = (serverless) => {
  const functions = getFunctions(serverless)

  return Object.keys(functions).reduce((accum, name) => {
    const func = functions[name]
    if (!func.events) return accum

    const events = func.events.filter(event => 'http' in event).map(event => {
      const http = getHttpConfig(functions, event.http)
      const config = Object.assign({}, func.config, { http })

      if (http.cors && http.cors.methods) {
        if (accum.corsMethodsForPath[http.path]) {
          // eslint-disable-next-line no-param-reassign
          accum.corsMethodsForPath = http.cors.methods.reduce((acc, val) => {
            if (acc[http.path].indexOf(val) === -1) {
              acc[http.path].push(val)
            }
            return acc
          }, accum.corsMethodsForPath)
        } else {
          // eslint-disable-next-line no-param-reassign
          accum.corsMethodsForPath[http.path] = http.cors.methods.slice()
        }
      }

      return Object.freeze(config)
    })

    return {
      endpoints: accum.endpoints.concat(events),
      corsMethodsForPath: accum.corsMethodsForPath,
    }
  }, {
    endpoints: [],
    corsMethodsForPath: {},
  })
}

const getMockServices = (serverless, file, host) => {
  let options = serverless.service.custom &&
    serverless.service.custom.simulate &&
    serverless.service.custom.simulate.services

  if (options === undefined) {
    options = {}
  }

  if (typeof options === 'string') {
    options = {
      file: options,
    }
  }

  return {
    file: options.file || file,
    host: options.host || host,
    projectName: normalizeProjectName(options.projectName),
  }
}

module.exports = {
  getFunctionConfig: (serverless, functionName) => {
    const func = getFunction(serverless, functionName)
    if (!func) return null

    return getFunctionConfig(serverless, functionName, func.config)
  },
  getFunctions: (serverless) => {
    const functions = getFunctions(serverless) || {}
    return Object.keys(functions).map(key => functions[key].config)
  },
  getMockServices,
  getEndpoints,
  getGraphqlFunc,
}

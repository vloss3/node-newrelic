/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const recordExternal = require('../../metrics/recorders/http_external')
const urltils = require('../../util/urltils')
const hashes = require('../../util/hashes')
const logger = require('../../logger').child({ component: 'outbound' })
const shimmer = require('../../shimmer')
const url = require('url')
const copy = require('../../util/copy')

const NAMES = require('../../metrics/names')
const SHIM_SYMBOLS = require('../../shim/constants').SYMBOLS

const DEFAULT_HOST = 'localhost'
const DEFAULT_PORT = 80
const DEFAULT_SSL_PORT = 443

const NEWRELIC_ID_HEADER = 'x-newrelic-id'
const NEWRELIC_TRANSACTION_HEADER = 'x-newrelic-transaction'
const NEWRELIC_SYNTHETICS_HEADER = 'x-newrelic-synthetics'

/**
 * Instruments an outbound HTTP request.
 *
 * @param {Agent} agent
 * @param {object} opts
 * @param {function} makeRequest
 *
 * @return {http.ClientRequest} The instrumented outbound request.
 */
module.exports = function instrumentOutbound(agent, opts, makeRequest) {
  if (typeof opts === 'string') {
    opts = url.parse(opts)
  } else {
    opts = copy.shallow(opts)
  }

  let hostname = opts.hostname || opts.host || DEFAULT_HOST
  let port = opts.port || opts.defaultPort
  if (!port) {
    port = !opts.protocol || opts.protocol === 'http:' ? DEFAULT_PORT : DEFAULT_SSL_PORT
  }

  if (!hostname || port < 1) {
    logger.warn('Invalid host name (%s) or port (%s) for outbound request.', hostname, port)
    return makeRequest(opts)
  }

  // Technically we shouldn't append the port if this is an https request on 443
  // but due to legacy issues we can't do that without moving customer's cheese.
  //
  // TODO: Move customers cheese by not appending the default port for https.
  if (port && port !== DEFAULT_PORT) {
    hostname += ':' + port
  }

  const name = NAMES.EXTERNAL.PREFIX + hostname

  const parent = agent.tracer.getSegment()
  if (parent && parent.opaque) {
    logger.trace(
      'Not capturing data for outbound request (%s) because parent segment opaque (%s)',
      name,
      parent.name
    )

    return makeRequest(opts)
  }

  return agent.tracer.addSegment(
    name,
    recordExternal(hostname, 'http'),
    parent,
    false,
    instrumentRequest
  )

  function instrumentRequest(segment) {
    const transaction = segment.transaction
    const outboundHeaders = Object.create(null)

    if (agent.config.encoding_key && transaction.syntheticsHeader) {
      outboundHeaders[NEWRELIC_SYNTHETICS_HEADER] = transaction.syntheticsHeader
    }

    // TODO: abstract header logic shared with TransactionShim#insertCATRequestHeaders
    if (agent.config.distributed_tracing.enabled) {
      if (opts.headers && opts.headers[SHIM_SYMBOLS.DISABLE_DT]) {
        logger.trace('Distributed tracing disabled by instrumentation.')
      } else {
        transaction.insertDistributedTraceHeaders(outboundHeaders)
      }
    } else if (agent.config.cross_application_tracer.enabled) {
      if (agent.config.encoding_key) {
        _addCATHeaders(agent, transaction, outboundHeaders)
      } else {
        logger.trace('No encoding key found, not adding CAT headers')
      }
    } else {
      logger.trace('CAT disabled, not adding headers!')
    }

    if (Array.isArray(opts.headers)) {
      opts.headers = opts.headers.slice()
      Array.prototype.push.apply(
        opts.headers,
        Object.keys(outboundHeaders).map(function getHeaderTuples(key) {
          return [key, outboundHeaders[key]]
        })
      )
    } else {
      opts.headers = Object.assign(Object.create(null), opts.headers, outboundHeaders)
    }

    segment.start()
    const request = makeRequest(opts)
    const parsed = urltils.scrubAndParseParameters(request.path)
    const proto = parsed.protocol || opts.protocol || 'http:'
    segment.name += parsed.path
    Object.defineProperty(request, '__NR_segment', {
      value: segment
    })

    if (parsed.parameters) {
      // Scrub and parse returns on object with a null prototype.
      // eslint-disable-next-line guard-for-in
      for (const key in parsed.parameters) {
        segment.addSpanAttribute(`request.parameters.${key}`, parsed.parameters[key])
      }
    }
    segment.addAttribute('url', `${proto}//${hostname}${parsed.path}`)
    segment.addAttribute('procedure', opts.method || 'GET')

    // Wrap the emit method. We're doing a special wrapper instead of using
    // `tracer.bindEmitter` because we want to do some logic based on certain
    // events.
    shimmer.wrapMethod(request, 'request.emit', 'emit', function wrapEmit(emit) {
      const boundEmit = agent.tracer.bindFunction(emit, segment)
      return function wrappedRequestEmit(evnt, arg) {
        if (evnt === 'error') {
          segment.end()
          handleError(segment, request, arg)
        } else if (evnt === 'response') {
          handleResponse(segment, hostname, request, arg)
        }

        return boundEmit.apply(this, arguments)
      }
    })
    _makeNonEnumerable(request, 'emit')

    return request
  }
}

/**
 * Notices the given error if there is no listener for the `error` event on the
 * request object.
 *
 * @param {TraceSegment} segment
 * @param {http.ClientRequest} req
 * @param {Error} error
 *
 * @return {bool} True if the error will be collected by New Relic.
 */
function handleError(segment, req, error) {
  if (req.listenerCount('error') > 0) {
    logger.trace(error, 'Not capturing outbound error because user has already handled it.')
    return false
  }

  logger.trace(error, 'Captured outbound error on behalf of the user.')
  const tx = segment.transaction
  tx.agent.errors.add(tx, error)
  return true
}

/**
 * Ties the response object to the request segment.
 *
 * @param {TraceSegment} segment
 * @param {string} hostname
 * @param {http.ClientRequest} req
 * @param {http.IncomingMessage} res
 */
function handleResponse(segment, hostname, req, res) {
  // Add response attributes for spans
  segment.addSpanAttribute('http.statusCode', res.statusCode)
  segment.addSpanAttribute('http.statusText', res.statusMessage)

  // If CAT is enabled, grab those headers!
  const agent = segment.transaction.agent
  if (agent.config.cross_application_tracer.enabled && !agent.config.distributed_tracing.enabled) {
    pullCatHeaders(agent.config, segment, hostname, res.headers['x-newrelic-app-data'])
  }

  // Again a custom emit wrapper because we want to watch for the `end` event.
  shimmer.wrapMethod(res, 'response', 'emit', function wrapEmit(emit) {
    const boundEmit = agent.tracer.bindFunction(emit, segment)
    return function wrappedResponseEmit(evnt) {
      if (evnt === 'end') {
        segment.end()
      }
      return boundEmit.apply(this, arguments)
    }
  })
  _makeNonEnumerable(res, 'emit')
}

function pullCatHeaders(config, segment, host, obfAppData) {
  if (!config.encoding_key) {
    logger.trace('config.encoding_key is not set - not parsing response CAT headers')
    return
  }

  if (!config.trusted_account_ids) {
    logger.trace('config.trusted_account_ids is not set - not parsing response CAT headers')
    return
  }

  // is our downstream request CAT-aware?
  if (!obfAppData) {
    logger.trace('Got no CAT app data in response header x-newrelic-app-data')
  } else {
    let appData = null
    try {
      appData = JSON.parse(hashes.deobfuscateNameUsingKey(obfAppData, config.encoding_key))
    } catch (e) {
      logger.warn('Got an unparsable CAT header x-newrelic-app-data: %s', obfAppData)
      return
    }
    // Make sure it is a trusted account
    if (appData.length && typeof appData[0] === 'string') {
      let accountId = appData[0].split('#')[0]
      accountId = parseInt(accountId, 10)
      if (config.trusted_account_ids.indexOf(accountId) === -1) {
        logger.trace('Response from untrusted CAT header account id: %s', accountId)
      } else {
        segment.catId = appData[0]
        segment.catTransaction = appData[1]
        segment.name =
          NAMES.EXTERNAL.TRANSACTION + host + '/' + segment.catId + '/' + segment.catTransaction
        if (appData.length >= 6) {
          segment.addAttribute('transaction_guid', appData[5])
        }
        logger.trace('Got inbound response CAT headers in transaction %s', segment.transaction.id)
      }
    }
  }
}

function _makeNonEnumerable(obj, prop) {
  try {
    const desc = Object.getOwnPropertyDescriptor(obj, prop)
    desc.enumerable = false
    Object.defineProperty(obj, prop, desc)
  } catch (e) {
    logger.debug(e, 'Failed to make %s non enumerable.', prop)
  }
}

function _addCATHeaders(agent, tx, outboundHeaders) {
  if (agent.config.obfuscatedId) {
    outboundHeaders[NEWRELIC_ID_HEADER] = agent.config.obfuscatedId
  }

  const pathHash = hashes.calculatePathHash(
    agent.config.applications()[0],
    tx.getFullName() || '',
    tx.referringPathHash
  )
  tx.pushPathHash(pathHash)

  try {
    let txData = JSON.stringify([tx.id, false, tx.tripId || tx.id, pathHash])
    txData = hashes.obfuscateNameUsingKey(txData, agent.config.encoding_key)
    outboundHeaders[NEWRELIC_TRANSACTION_HEADER] = txData

    logger.trace('Added outbound request CAT headers in transaction %s', tx.id)
  } catch (err) {
    logger.trace(err, 'Failed to create CAT payload')
  }
}

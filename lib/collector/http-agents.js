/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const parse = require('url').parse
const ProxyAgent = require('https-proxy-agent')
const logger = require('../logger').child({ component: 'http-agent' })
const certificates = require('./ssl/certificates.js')

const https = require('https')

// poor person's single-instance-objects.  We
// only ever instantiate one of each HTTP-agent
// and just reuse the same object in all the
// requests. This is how node does keep-alive.
let agentKeepAlive = null
let agentProxyWithKeepAlive = null

/**
 * Returns an HTTP agent with keep-alive enabled
 */
exports.keepAliveAgent = function keepAliveAgent(config) {
  config = config ? config : {}

  // always return the same agent instance, which
  // ensures all requests share the same http
  // connection
  if (null !== agentKeepAlive) {
    return agentKeepAlive
  }

  config.keepAlive = true
  agentKeepAlive = new https.Agent(config)
  return agentKeepAlive
}

/**
 * Returns an HTTP-agent provided by the https-proxy-agent
 * NPM package with configuration suitable for working via
 * the configured newrelic-agent's proxy configuration.
 *
 * Include keep-alive configuration, but ultimately its up
 * to the proxy server as to how its connection is made
 * with New Relic's servers.
 */
exports.proxyAgent = function proxyAgent(config) {
  if (null !== agentProxyWithKeepAlive) {
    return agentProxyWithKeepAlive
  }
  const opts = proxyOptions(config)
  const proxyUrl = opts.proxy_url

  const proxyOpts = {
    host: proxyUrl.host,
    port: proxyUrl.port,
    protocol: proxyUrl.protocol,
    secureEndpoint: config.ssl,
    auth: proxyUrl.auth,
    ca: opts.certificates,
    keepAlive: true
  }

  logger.info(
    {
      host: proxyOpts.host,
      port: proxyOpts.port,
      auth: !!proxyOpts.auth,
      protocol: proxyUrl.protocol
    },
    'using proxy'
  )

  agentProxyWithKeepAlive = new ProxyAgent(proxyOpts)
  return agentProxyWithKeepAlive
}

function proxyOptions(config) {
  if (config.proxy) {
    const parsedUrl = parse(config.proxy)

    var proxyUrl = {
      protocol: parsedUrl.protocol || 'https:',
      host: parsedUrl.hostname,
      port: parsedUrl.port || 80,
      auth: parsedUrl.auth
    }
  } else {
    let proxyAuth = config.proxy_user
    if (config.proxy_pass !== '') {
      proxyAuth += ':' + config.proxy_pass
    }

    // Unless a proxy config is provided, default to HTTP.
    proxyUrl = {
      protocol: 'https:',
      host: config.proxy_host || 'localhost',
      port: config.proxy_port || 80,
      auth: proxyAuth
    }
  }

  const opts = {
    proxy_url: proxyUrl
  }

  if (config.certificates && config.certificates.length > 0) {
    opts.certificates = config.certificates

    // merge user certificates with built-in certs
    if (config.feature_flag.certificate_bundle) {
      logger.info(
        'Using a proxy with a special cert. This enables our cert bundle which, combined ' +
          'with some versions of node, exacerbates a leak in node core TLS.'
      )

      const certWarningMessage = [
        'Deprecation Warning: The certificate bundle included by New Relic will be ',
        'disabled by default and then fully removed in later major versions. We recommend ',
        'testing with the certificate_bundle feature flag set to `false` to determine if ',
        'you will need to modify your environment or setup your own appropriate bundle. ',
        'Example configuration: feature_flag: { certificate_bundle: false }.'
      ].join('')
      logger.warnOnce('CERT_WARNING', certWarningMessage)

      opts.certificates = config.certificates.concat(certificates)
    }
  }

  return opts
}

/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const fs = require('fs')
const mongoPackage = require('mongodb/package.json')
const params = require('../../lib/params')
const semver = require('semver')
const urltils = require('../../../lib/util/urltils')

const MONGO_SEGMENT_RE = /^Datastore\/.*?\/MongoDB/
const TRANSACTION_NAME = 'mongo test'
const DB_NAME = 'integration'

exports.MONGO_SEGMENT_RE = MONGO_SEGMENT_RE
exports.TRANSACTION_NAME = TRANSACTION_NAME
exports.DB_NAME = DB_NAME

exports.connect = semver.satisfies(mongoPackage.version, '<3') ? connectV2 : connectV3

exports.checkMetrics = checkMetrics
exports.close = close
exports.getHostName = getHostName
exports.getPort = getPort
exports.getDomainSocketPath = getDomainSocketPath

function connectV2(mongodb, path) {
  return new Promise((resolve, reject) => {
    let server = null
    if (path) {
      server = new mongodb.Server(path)
    } else {
      server = new mongodb.Server(params.mongodb_host, params.mongodb_port, {
        socketOptions: {
          connectionTimeoutMS: 30000,
          socketTimeoutMS: 30000
        }
      })
    }

    const db = new mongodb.Db(DB_NAME, server)

    db.open(function (err) {
      if (err) {
        reject(err)
      }

      resolve({ db, client: null })
    })
  })
}

function connectV3(mongodb, host, replicaSet = false) {
  return new Promise((resolve, reject) => {
    if (host) {
      host = encodeURIComponent(host)
    } else {
      host = params.mongodb_host + ':' + params.mongodb_port
    }

    let connString = `mongodb://${host}`
    let options = {}

    if (replicaSet) {
      connString = `mongodb://${host},${host},${host}`
      options = { useNewUrlParser: true, useUnifiedTopology: true }
    }
    mongodb.MongoClient.connect(connString, options, function (err, client) {
      if (err) {
        reject(err)
      }

      const db = client.db(DB_NAME)
      resolve({ db, client })
    })
  })
}

function close(client, db) {
  return new Promise((resolve) => {
    if (db && typeof db.close === 'function') {
      db.close(resolve)
    } else if (client) {
      client.close(true, resolve)
    } else {
      resolve()
    }
  })
}

function getHostName(agent) {
  return urltils.isLocalhost(params.mongodb_host)
    ? agent.config.getHostnameSafe()
    : params.mongodb_host
}

function getPort() {
  return String(params.mongodb_port)
}

function checkMetrics(t, agent, host, port, metrics) {
  const agentMetrics = getMetrics(agent)

  const unscopedMetrics = agentMetrics.unscoped
  const unscopedDatastoreNames = Object.keys(unscopedMetrics).filter((input) => {
    return input.includes('Datastore')
  })

  const scoped = agentMetrics.scoped[TRANSACTION_NAME]
  let total = 0

  if (!t.ok(scoped, 'should have scoped metrics')) {
    return
  }
  t.equal(Object.keys(agentMetrics.scoped).length, 1, 'should have one metric scope')
  for (let i = 0; i < metrics.length; ++i) {
    let count = null
    let name = null

    if (Array.isArray(metrics[i])) {
      count = metrics[i][1]
      name = metrics[i][0]
    } else {
      count = 1
      name = metrics[i]
    }

    total += count

    t.equal(
      unscopedMetrics['Datastore/operation/MongoDB/' + name].callCount,
      count,
      'unscoped operation metric should be called ' + count + ' times'
    )
    t.equal(
      unscopedMetrics['Datastore/statement/MongoDB/testCollection/' + name].callCount,
      count,
      'unscoped statement metric should be called ' + count + ' times'
    )
    t.equal(
      scoped['Datastore/statement/MongoDB/testCollection/' + name].callCount,
      count,
      'scoped statement metric should be called ' + count + ' times'
    )
  }

  const expectedUnscopedCount = 5 + 2 * metrics.length
  t.equal(
    unscopedDatastoreNames.length,
    expectedUnscopedCount,
    'should have ' + expectedUnscopedCount + ' unscoped metrics'
  )
  const expectedUnscopedMetrics = [
    'Datastore/all',
    'Datastore/allWeb',
    'Datastore/MongoDB/all',
    'Datastore/MongoDB/allWeb',
    'Datastore/instance/MongoDB/' + host + '/' + port
  ]
  expectedUnscopedMetrics.forEach(function (metric) {
    if (t.ok(unscopedMetrics[metric], 'should have unscoped metric ' + metric)) {
      t.equal(unscopedMetrics[metric].callCount, total, 'should have correct call count')
    }
  })
}

function getDomainSocketPath() {
  const files = fs.readdirSync('/tmp')
  for (let i = 0; i < files.length; ++i) {
    const file = '/tmp/' + files[i]
    if (/^\/tmp\/mongodb.*?\.sock$/.test(file)) {
      return file
    }
  }
  return null
}

function getMetrics(agent) {
  return agent.metrics._metrics
}

/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

const logger = require('../../logger').child({ component: 'tx_segment_normalizer' })

module.exports = TxSegmentNormalizer

function TxSegmentNormalizer() {
  this.terms = []
}

/**
 * This normalize method is wicked. The best bet is to read the spec:
 * https://newrelic.atlassian.net/wiki/pages/viewpage.action?spaceKey=eng&title=Language+agent+transaction+segment+terms+rules
 *
 * A copy paste of the rules that were followed:
 *  1. Find the first rule where the prefix key matches the prefix of the
 *     transaction name. If no matching rules are found, abort.
 *  2. Strip the prefix from the transaction name.
 *  3. Split the rest of the transaction name into segments on slashes ('/').
 *  4. For each segment:
 *      If the segment appears in the array of strings given under the terms key,
 *      keep it unchanged. Else, replace it with a placeholder ('*')
 *  5. Collapse all adjacent placeholder segments into a single '*' segment.
 *  6. Join together the modified segments with slashes, and re-prepend the prefix.
 *
 * @param {string} path - The transaction metric path to normalize.
 *
 * @return {NormalizationResults} - The results of normalizing the given path.
 */
TxSegmentNormalizer.prototype.normalize = function normalize(path) {
  let currentTerm
  let prefix
  for (let i = 0; i < this.terms.length; i++) {
    currentTerm = this.terms[i]
    prefix = currentTerm.prefix
    if (path.lastIndexOf(prefix, 0) === -1) {
      continue
    }
    const fragment = path.slice(prefix.length)
    const parts = fragment.split('/')
    const result = []
    var prev

    var segment
    for (let j = 0; j < parts.length; j++) {
      segment = parts[j]

      if (segment === '' && j + 1 === parts.length) {
        break
      }

      if (currentTerm.terms.indexOf(segment) === -1) {
        if (prev === '*') {
          continue
        }
        result.push((prev = '*'))
      } else {
        result.push((prev = segment))
      }
    }
    logger.trace('Normalizing %s because of rule: %s', path, currentTerm)
    return {
      matched: true, // To match MetricNormalizer
      ignore: false, // ^^
      value: prefix + result.join('/')
    }
  }

  return {
    matched: false, // To match MetricNormalizer
    ignore: false, // ^^
    value: path
  }
}

TxSegmentNormalizer.prototype.load = function load(json) {
  if (Array.isArray(json)) {
    this.terms = filterRules(json)
  } else {
    logger.warn('transaction_segment_terms was not an array got: %s (%s)', typeof json, json)
  }
}

function filterRules(rules) {
  const map = Object.create(null)

  for (var i = 0, l = rules.length; i < l; ++i) {
    let prefix = rules[i].prefix

    if (!prefix || typeof prefix !== 'string') {
      continue
    }

    if (prefix[prefix.length - 1] !== '/') {
      prefix = prefix + '/'
      rules[i].prefix = prefix
    }

    const segments = prefix.split('/')
    if (segments.length !== 3 || !segments[0] || !segments[1] || segments[3]) {
      continue
    }

    if (Array.isArray(rules[i].terms)) {
      map[prefix] = rules[i]
    }
  }

  const keys = Object.keys(map)
  const filtered = new Array(keys.length)

  for (i = 0, l = keys.length; i < l; ++i) {
    filtered[i] = map[keys[i]]
  }

  return filtered
}

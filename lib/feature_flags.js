/*
 * Copyright 2020 New Relic Corporation. All rights reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

'use strict'

// unreleased flags gating an active feature
exports.prerelease = {
  express5: false,
  await_support: true,
  promise_segments: false,
  reverse_naming_rules: false,
  fastify_instrumentation: false,
  certificate_bundle: false,
  new_promise_tracking: false,
  unresolved_promise_cleanup: true
}

// flags that are no longer used for released features
exports.released = [
  'released',
  'cat',
  'custom_instrumentation',
  'custom_metrics',
  'express_segments',
  'native_metrics',
  'protocol_17',
  'serverless_mode',
  'send_request_uri_attribute',
  'synthetics',
  'dt_format_w3c'
]

// flags that are no longer used for unreleased features
exports.unreleased = ['unreleased']

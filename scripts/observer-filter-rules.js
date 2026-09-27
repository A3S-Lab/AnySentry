'use strict';

// Permanent compatibility entrypoint. Existing Forwarder code and operator tests import this path;
// implementation state and the additive S5 wire contract are kept in cohesive sibling modules.
module.exports = require('./observer-filter-rule-publisher');

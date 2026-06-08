'use strict';
// Tiny zero-dependency test harness.
var passed = 0, failed = 0;
var failures = [];

function eq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function test(name, fn) {
  try {
    fn({
      equal: function (actual, expected, note) {
        if (!eq(actual, expected)) {
          throw new Error((note || '') + '\n    expected: ' + JSON.stringify(expected) +
            '\n    actual:   ' + JSON.stringify(actual));
        }
      },
      ok: function (cond, note) { if (!cond) throw new Error(note || 'expected truthy'); }
    });
    passed++;
    console.log('  ✓ ' + name);
  } catch (e) {
    failed++;
    failures.push(name);
    console.log('  ✗ ' + name + '\n    ' + e.message);
  }
}

function summary() {
  console.log('\n' + passed + ' passed, ' + failed + ' failed');
  if (failed) { process.exitCode = 1; }
}

module.exports = { test: test, summary: summary, get failed() { return failed; } };

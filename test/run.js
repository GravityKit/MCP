#!/usr/bin/env node

/**
 * Test Runner for Gravity MCP
 * Runs all test suites and reports results
 */

import authTests from './authentication.test.js';
import formsTests from './forms.test.js';
import entriesTests from './entries.test.js';
import feedsTests from './feeds.test.js';
import submissionsTests from './submissions.test.js';
import serverToolsTests from './server-tools.test.js';
import compactTests from './compact.test.js';
import validationTests from './validation.test.js';
import sanitizeTests from './sanitize.test.js';
import bugFixesTests from './bug-fixes.test.js';
import mutexTests from './mutex.test.js';
import abilitiesLoaderTests from './abilities-loader.test.js';

// Test suites to run
const testSuites = [
  authTests,
  formsTests,
  entriesTests,
  feedsTests,
  submissionsTests,
  serverToolsTests,
  compactTests,
  validationTests,
  sanitizeTests,
  mutexTests,
  bugFixesTests,
  abilitiesLoaderTests
];

// Test statistics
let totalPassed = 0;
let totalFailed = 0;
let allFailures = [];

console.log('🚀 Gravity MCP Test Suite');
console.log('=====================================\n');

// Run all test suites
async function runAllTests() {
  const startTime = Date.now();

  for (const suite of testSuites) {
    const result = await suite.run();
    totalPassed += result.passed;
    totalFailed += result.failed;

    if (result.failures && result.failures.length > 0) {
      allFailures.push(...result.failures.map(f => ({
        suite: suite.name,
        ...f
      })));
    }
  }

  const endTime = Date.now();
  const duration = ((endTime - startTime) / 1000).toFixed(2);

  // Print final summary
  console.log('\n' + '='.repeat(60));
  console.log('📊 FINAL TEST RESULTS');
  console.log('='.repeat(60));

  console.log(`\n✅ Passed: ${totalPassed}`);
  console.log(`❌ Failed: ${totalFailed}`);
  console.log(`⏱️  Duration: ${duration}s`);

  const passRate = totalPassed + totalFailed > 0
    ? ((totalPassed / (totalPassed + totalFailed)) * 100).toFixed(1)
    : 0;

  console.log(`📈 Pass Rate: ${passRate}%`);

  // Print all failures if any
  if (allFailures.length > 0) {
    console.log('\n' + '='.repeat(60));
    console.log('❌ FAILED TESTS SUMMARY');
    console.log('='.repeat(60));

    allFailures.forEach((failure, index) => {
      console.log(`\n${index + 1}. [${failure.suite}] ${failure.test}`);
      console.log(`   Error: ${failure.error}`);
    });
  }

  // Exit with appropriate code
  if (totalFailed > 0) {
    console.log('\n❌ Tests failed! Please fix the issues above.');
    process.exit(1);
  } else {
    console.log('\n✅ All tests passed! Great job!');
    process.exit(0);
  }
}

// Handle errors
process.on('unhandledRejection', (error) => {
  console.error('\n❌ Unhandled error in tests:', error);
  process.exit(1);
});

// Run tests
runAllTests().catch(error => {
  console.error('\n❌ Test runner failed:', error);
  process.exit(1);
});

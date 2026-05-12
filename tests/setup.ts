// Ensure JWT_SECRET is set for tests. The middleware/auth module now
// validates this lazily and refuses placeholder values, so tests need a
// real-looking value.
process.env.JWT_SECRET ||= 'test-secret-test-secret-test-secret-test-secret-test-secret-test';

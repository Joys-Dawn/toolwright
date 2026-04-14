// Test fixture: exits with code 2 (SELF_RECORDED_FAILURE_EXIT_CODE),
// simulating a bridge that has already written its own circuit-breaker
// entry before exiting. Parent must NOT record a second failure.

process.exit(2);

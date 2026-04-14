// Test fixture: a "bridge" that writes to stderr and exits with code 1,
// simulating a misconfigured real bridge (e.g. missing token) so we can
// verify bridge-spawn forwards stderr into bridge.log.

process.stderr.write('[bridge] simulated startup failure\n');
process.exit(1);

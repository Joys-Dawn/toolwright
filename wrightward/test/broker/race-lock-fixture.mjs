// Subprocess fixture for the lifecycle race-condition test.
// Takes: argv[2] = collabDir, argv[3] = session id.
// Outputs: JSON {acquired, pid} on stdout and holds the lock for 1.5s on win.
import { acquireLock } from '../../broker/lifecycle.mjs';

const r = acquireLock(process.argv[2], { sessionId: process.argv[3] });
process.stdout.write(JSON.stringify({ acquired: r.acquired, pid: process.pid }));
if (r.acquired) {
  setTimeout(() => process.exit(0), 1500);
}

// Test fixture: a "bridge" that just idles until SIGTERM.
// Used by bridge-spawn tests that need to verify child-process behavior
// without pulling in the real bridge's Discord/network dependencies.

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
// Stay alive indefinitely until the parent kills us.
setInterval(() => {}, 1 << 30);

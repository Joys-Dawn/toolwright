export function makeLimiter(maxConcurrent) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (active < maxConcurrent && queue.length) {
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve().then(fn).then(
        v => { active--; resolve(v); pump(); },
        e => { active--; reject(e); pump(); }
      );
    }
  };
  return (fn) => new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    pump();
  });
}

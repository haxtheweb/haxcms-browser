// AsyncLocalStorage for the browser runtime. The Worker handles one request
// at a time, so the store is restored when run() finishes (sync or async)
// instead of following async context.
class AsyncLocalStorage {
  constructor() {
    this.store = undefined;
  }
  getStore() {
    return this.store;
  }
  run(store, fn, ...args) {
    const previous = this.store;
    this.store = store;
    let result;
    try {
      result = fn(...args);
    } catch (e) {
      this.store = previous;
      throw e;
    }
    if (result && typeof result.then === "function") {
      return result.finally(() => {
        this.store = previous;
      });
    }
    this.store = previous;
    return result;
  }
  enterWith(store) {
    this.store = store;
  }
  exit(fn, ...args) {
    return fn(...args);
  }
  disable() {}
}

class AsyncResource {
  runInAsyncScope(fn, thisArg, ...args) {
    return fn.apply(thisArg, args);
  }
  bind(fn) {
    return fn;
  }
  static bind(fn) {
    return fn;
  }
}

module.exports = {
  AsyncLocalStorage,
  AsyncResource,
  executionAsyncId: () => 0,
  createHook: () => ({ enable() {}, disable() {} }),
};

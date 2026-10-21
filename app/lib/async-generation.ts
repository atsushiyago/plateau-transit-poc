/** Ignore obsolete work; retry transient failures with capped exponential backoff. */
export class TileWorkGate<T extends object> {
  generation = 0;
  private states = new WeakMap<T, { generation: number; busy: boolean; done: boolean; failures: number; retryAt: number }>();
  invalidate() { return ++this.generation; }
  forget(key: T) { this.states.delete(key); }
  async run(key: T, work: (generation: number) => Promise<boolean>, now = Date.now()) {
    let state = this.states.get(key);
    if (state?.generation === this.generation && (state.busy || state.done || state.retryAt > now)) return;
    if (!state || state.generation !== this.generation) {
      state = { generation: this.generation, busy: false, done: false, failures: 0, retryAt: 0 };
      this.states.set(key, state);
    }
    state.busy = true;
    try { state.done = await work(state.generation); }
    catch { state.done = false; }
    finally {
      state.busy = false;
      if (!state.done) {
        state.failures++;
        state.retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(state.failures - 1, 5));
      }
    }
  }
}

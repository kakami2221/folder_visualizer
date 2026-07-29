export class LruRangeCache {
  constructor(limit = 3) {
    this.limit = Math.max(1, Math.floor(Number(limit) || 3));
    this.values = new Map();
  }

  get(key) {
    if (!this.values.has(key)) {
      return undefined;
    }
    const value = this.values.get(key);
    this.values.delete(key);
    this.values.set(key, value);
    return value;
  }

  set(key, value) {
    this.values.delete(key);
    this.values.set(key, value);
    while (this.values.size > this.limit) {
      this.values.delete(this.values.keys().next().value);
    }
    return value;
  }

  has(key) {
    return this.values.has(key);
  }

  clear() {
    this.values.clear();
  }

  get keys() {
    return [...this.values.keys()];
  }
}

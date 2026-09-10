/**
 * Small seedable PRNG (mulberry32). Seeded episodes make trajectories
 * exactly reproducible: (seed, action sequence) → identical states, which
 * lets the training pipeline re-simulate instead of trusting logged states.
 */
export class Rng {
  private s: number;

  private static assertState(state: number): void {
    if (!Number.isSafeInteger(state) || state < 0 || state > 0xffffffff) {
      throw new RangeError("RNG state must be an unsigned 32-bit integer");
    }
  }

  constructor(seed: number) {
    this.s = seed >>> 0;
  }

  static fromState(state: number): Rng {
    Rng.assertState(state);
    return new Rng(state);
  }

  exportState(): number {
    return this.s;
  }

  /** Float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [0, n). */
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
}

/** 离线演示：均值回归随机游走价格源（固定种子，无需网络）。 */

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 确定性随机游走：startPx 起、围绕 start_px 均值回归，STEP 秒一格。 */
export function createWalkPriceFn({ startPx = 65000, vol = 0.005, stepS = 3, steps = 100000, seed = 20261118 } = {}) {
  const rnd = mulberry32(seed);
  const gauss = () => {
    // Box-Muller
    const u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const path = [startPx];
  let px = startPx;
  for (let i = 1; i < steps; i++) {
    px *= Math.exp(gauss() * vol - 0.03 * Math.log(px / startPx));
    path.push(px);
  }
  const t0 = Date.now();
  return () => {
    const n = Math.max(0, Math.min(Math.floor((Date.now() - t0) / (stepS * 1000)), steps - 1));
    return path[n];
  };
}

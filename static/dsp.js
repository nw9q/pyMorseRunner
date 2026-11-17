/**
 * Morse Runner DSP Engine (Ported from VE3NEA Delphi/Pascal source under MPL-2.0)
 * Includes:
 *  - RndFunc.pas (Gaussian, Rayleigh, Poisson, U-Shaped distributions)
 *  - MorseTbl.pas & MorseKey.pas (Blackman-Harris step-response CW keyer)
 *  - MovAvg.pas & QuickAvg.pas (Multi-pass cascaded moving average filters)
 *  - Qsb.pas (Rayleigh fading & auroral flutter)
 *  - Mixers.pas (Complex baseband to audio pitch modulator)
 *  - VolumCtl.pas (Windowed log-magnitude attack/hold AGC)
 *  - Middleton Class B / Pareto Sferic QRN synthesizer
 */

"use strict";

const DSP = (() => {
  const DEFAULTRATE = 11025;
  const DEFAULTBUFSIZE = 512;
  const TWO_PI = 2 * Math.PI;
  const NEVER = 2147483647;

  // ---------------------------------------------------------------------------
  // RndFunc.pas
  // ---------------------------------------------------------------------------
  function rndNormal() {
    let u1 = 0;
    let u2 = 0;
    while (u1 <= 1e-12) u1 = Math.random();
    u2 = Math.random();
    return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(TWO_PI * u2);
  }

  function rndGaussLim(mean, lim) {
    const val = mean + rndNormal() * 0.5 * lim;
    return Math.max(mean - lim, Math.min(mean + lim, val));
  }

  function rndRayleigh(mean) {
    let u1 = 0;
    let u2 = 0;
    while (u1 <= 1e-12) u1 = Math.random();
    while (u2 <= 1e-12) u2 = Math.random();
    return mean * Math.sqrt(-Math.log(u1) - Math.log(u2));
  }

  function rndUniform() {
    return 2.0 * Math.random() - 1.0;
  }

  function rndUShaped() {
    return Math.sin(Math.PI * (Math.random() - 0.5));
  }

  function rndPoisson(mean) {
    const g = Math.exp(-mean);
    let t = 1.0;
    let res = 0;
    for (res = 0; res <= 30; res++) {
      t *= Math.random();
      if (t <= g) break;
    }
    return res;
  }

  function secondsToBlocks(sec, bufSize = DEFAULTBUFSIZE) {
    return Math.round((DEFAULTRATE / bufSize) * sec);
  }

  function blocksToSeconds(blocks, bufSize = DEFAULTBUFSIZE) {
    return (blocks * bufSize) / DEFAULTRATE;
  }

  // ---------------------------------------------------------------------------
  // Crc32.pas (For WPX Competition verification strings)
  // ---------------------------------------------------------------------------
  const CRC32_TABLE = new Uint32Array(256);
  (() => {
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      CRC32_TABLE[i] = c >>> 0;
    }
  })();

  function calculateCRC32(str, initCrc = 0xc90c2086) {
    let crc = initCrc >>> 0;
    for (let i = 0; i < str.length; i++) {
      const byte = str.charCodeAt(i) & 0xff;
      crc = ((crc >>> 8) ^ CRC32_TABLE[(byte ^ crc) & 0xff]) >>> 0;
    }
    return crc.toString(16).toUpperCase().padStart(8, "0");
  }

  // ---------------------------------------------------------------------------
  // MorseTbl.pas & MorseKey.pas
  // ---------------------------------------------------------------------------
  const MORSE_TABLE_RAW = [
    "1[.----]", "2[..---]", "3[...--]", "4[....-]", "5[.....]",
    "6[-....]", "7[--...]", "8[---..]", "9[----.]", "0[-----]",
    "A[.-]", "B[-...]", "C[-.-.]", "D[-..]", "E[.]", "F[..-.]",
    "G[--.]", "H[....]", "I[..]", "J[.---]", "K[-.-]", "L[.-..]",
    "M[--]", "N[-.]", "O[---]", "P[.--.]", "Q[--.-]", "R[.-.]",
    "S[...]", "T[-]", "U[..-]", "V[...-]", "W[.--]", "X[-..-]",
    "Y[-.--]", "Z[--..]", "/[-..-.]", ".[.-.-.-]", ",[--..--]",
    "?[..--..]", "=[-...-]", "\\[...-.]"
  ];

  class MorseKeyer {
    constructor(rate = DEFAULTRATE, bufSize = DEFAULTBUFSIZE) {
      this.rate = rate;
      this.bufSize = bufSize;
      this.morseMap = new Map();
      this.loadMorseTable();
      this.setRiseTime(0.005);
    }

    loadMorseTable() {
      for (const entry of MORSE_TABLE_RAW) {
        const ch = entry[0];
        const openIdx = entry.indexOf("[");
        const closeIdx = entry.indexOf("]");
        if (openIdx === 1 && closeIdx > openIdx) {
          this.morseMap.set(ch, entry.slice(openIdx + 1, closeIdx) + " ");
        }
      }
    }

    blackmanHarrisKernel(x) {
      const a0 = 0.35875;
      const a1 = 0.48829;
      const a2 = 0.14128;
      const a3 = 0.01168;
      return (
        a0 -
        a1 * Math.cos(2 * Math.PI * x) +
        a2 * Math.cos(4 * Math.PI * x) -
        a3 * Math.cos(6 * Math.PI * x)
      );
    }

    blackmanHarrisStepResponse(len) {
      const out = new Float32Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = this.blackmanHarrisKernel(i / len);
      }
      for (let i = 1; i < len; i++) {
        out[i] += out[i - 1];
      }
      const scale = out[len - 1] !== 0 ? 1.0 / out[len - 1] : 1.0;
      for (let i = 0; i < len; i++) {
        out[i] *= scale;
      }
      return out;
    }

    setRiseTime(riseTimeSec) {
      this.riseTime = riseTimeSec;
      this.rampLen = Math.max(4, Math.round(2.7 * this.riseTime * this.rate));
      this.rampOn = this.blackmanHarrisStepResponse(this.rampLen);
      this.rampOff = new Float32Array(this.rampLen);
      for (let i = 0; i < this.rampLen; i++) {
        this.rampOff[this.rampLen - 1 - i] = this.rampOn[i];
      }
    }

    encode(txt) {
      const upper = String(txt || "").toUpperCase();
      let res = "";
      for (let i = 0; i < upper.length; i++) {
        const ch = upper[i];
        if (ch === " " || ch === "_") {
          res += " ";
        } else if (this.morseMap.has(ch)) {
          res += this.morseMap.get(ch);
        }
      }
      if (res.length > 0) {
        res = res.slice(0, -1) + "~";
      }
      return res;
    }

    makeEnvelope(morseMsg, wpm, amplitude = 1.0) {
      const safeWpm = Math.max(5, Math.min(120, Number(wpm) || 20));
      let unitCnt = 0;
      for (let i = 0; i < morseMsg.length; i++) {
        switch (morseMsg[i]) {
          case ".":
            unitCnt += 2;
            break;
          case "-":
            unitCnt += 4;
            break;
          case " ":
            unitCnt += 2;
            break;
          case "~":
            unitCnt += 1;
            break;
        }
      }

      const samplesInUnit = Math.max(this.rampLen + 2, Math.round((0.1 * this.rate * 12) / safeWpm));
      const trueEnvelopeLen = unitCnt * samplesInUnit + this.rampLen;
      const len = this.bufSize * Math.ceil(trueEnvelopeLen / this.bufSize);
      const env = new Float32Array(len);

      let p = 0;
      const addRampOn = () => {
        env.set(this.rampOn, p);
        p += this.rampLen;
      };
      const addRampOff = () => {
        env.set(this.rampOff, p);
        p += this.rampLen;
      };
      const addOn = (dur) => {
        const count = dur * samplesInUnit - this.rampLen;
        for (let j = 0; j < count; j++) env[p + j] = 1.0;
        p += count;
      };
      const addOff = (dur) => {
        p += dur * samplesInUnit - this.rampLen;
      };

      for (let i = 0; i < morseMsg.length; i++) {
        switch (morseMsg[i]) {
          case ".":
            addRampOn();
            addOn(1);
            addRampOff();
            addOff(1);
            break;
          case "-":
            addRampOn();
            addOn(3);
            addRampOff();
            addOff(1);
            break;
          case " ":
            p += 2 * samplesInUnit;
            break;
          case "~":
            p += 1 * samplesInUnit;
            break;
        }
      }

      if (amplitude !== 1.0) {
        for (let i = 0; i < len; i++) env[i] *= amplitude;
      }
      return env;
    }
  }

  // ---------------------------------------------------------------------------
  // QuickAvg.pas (Circular buffer multi-pass moving average for QSB)
  // ---------------------------------------------------------------------------
  class QuickAverage {
    constructor(points = 128, passes = 3) {
      this.passes = Math.max(1, Math.min(8, passes));
      this.points = Math.max(1, points);
      this.reset();
    }

    setPoints(points) {
      this.points = Math.max(1, points);
      this.reset();
    }

    reset() {
      this.reBufs = Array.from({ length: this.passes + 1 }, () => new Float64Array(this.points));
      this.imBufs = Array.from({ length: this.passes + 1 }, () => new Float64Array(this.points));
      this.scale = Math.pow(this.points, -this.passes);
      this.idx = 0;
      this.prevIdx = this.points - 1;
    }

    doFilter(val, bufs) {
      let res = val;
      for (let p = 1; p <= this.passes; p++) {
        const v = res;
        res = bufs[p][this.prevIdx] - bufs[p - 1][this.idx] + v;
        bufs[p - 1][this.idx] = v;
      }
      bufs[this.passes][this.idx] = res;
      return res * this.scale;
    }

    filterComplex(aRe, aIm) {
      const re = this.doFilter(aRe, this.reBufs);
      const im = this.doFilter(aIm, this.imBufs);
      this.prevIdx = this.idx;
      this.idx = (this.idx + 1) % this.points;
      return { re, im };
    }
  }

  // ---------------------------------------------------------------------------
  // Qsb.pas (Rayleigh Fading & Auroral Flutter)
  // ---------------------------------------------------------------------------
  class Qsb {
    constructor(bandwidth = 0.1, bufSize = DEFAULTBUFSIZE) {
      this.bufSize = bufSize;
      this.qsbLevel = 1.0;
      this.filt = new QuickAverage(128, 3);
      this.gain = 1.0;
      this.setBandwidth(bandwidth);
    }

    newGain() {
      const { re, im } = this.filt.filterComplex(rndUniform(), rndUniform());
      const mag = Math.sqrt((re * re + im * im) * 3.0 * this.filt.points);
      return mag * this.qsbLevel + (1.0 - this.qsbLevel);
    }

    setBandwidth(bw) {
      this.bandwidth = bw;
      const quarterBuf = Math.max(1, Math.floor(this.bufSize / 4));
      const pts = Math.max(2, Math.ceil((0.37 * DEFAULTRATE) / (quarterBuf * bw)));
      this.filt.setPoints(pts);
      for (let i = 0; i < pts * 3; i++) {
        this.gain = this.newGain();
      }
    }

    applyTo(arr) {
      const step = Math.max(1, Math.floor(this.bufSize / 4));
      const blkCnt = Math.floor(arr.length / step);
      for (let b = 0; b < blkCnt; b++) {
        const target = this.newGain();
        const dG = (target - this.gain) / step;
        const base = b * step;
        for (let i = 0; i < step; i++) {
          arr[base + i] *= this.gain;
          this.gain += dG;
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // MovAvg.pas (Block complex baseband low-pass filter for CW IF passband)
  // ---------------------------------------------------------------------------
  class MovingAverage {
    constructor(points = 16, passes = 3, samplesInInput = DEFAULTBUFSIZE, gainDb = 0) {
      this.passes = passes;
      this.points = Math.max(1, points);
      this.samplesInInput = samplesInInput;
      this.gainDb = gainDb;
      this.reset();
    }

    configure(points, gainDb) {
      this.points = Math.max(1, points);
      this.gainDb = gainDb;
      this.reset();
    }

    reset() {
      const len = this.samplesInInput + this.points;
      this.bufRe = Array.from({ length: this.passes + 1 }, () => new Float32Array(len));
      this.bufIm = Array.from({ length: this.passes + 1 }, () => new Float32Array(len));
      this.norm = Math.pow(10, 0.05 * this.gainDb) * Math.pow(this.points, -this.passes);
    }

    pushArray(src, dst) {
      const shiftLen = dst.length - src.length;
      dst.copyWithin(0, src.length);
      dst.set(src, shiftLen);
    }

    pass(src, dst) {
      // Shift previous state to the left by samplesInInput
      const start = dst.length - this.samplesInInput;
      dst.copyWithin(0, this.samplesInInput);

      // Running window sum over `this.points`
      let sum = dst[start - 1];
      for (let i = start; i < dst.length; i++) {
        sum = sum - src[i - this.points] + src[i];
        dst[i] = sum;
      }
    }

    doFilter(data, bufs) {
      this.pushArray(data, bufs[0]);
      for (let p = 1; p <= this.passes; p++) {
        this.pass(bufs[p - 1], bufs[p]);
      }
      const out = new Float32Array(this.samplesInInput);
      const last = bufs[this.passes];
      const offset = this.points;
      for (let i = 0; i < this.samplesInInput; i++) {
        out[i] = last[offset + i] * this.norm;
      }
      return out;
    }

    filterReIm(reIm) {
      return {
        re: this.doFilter(reIm.re, this.bufRe),
        im: this.doFilter(reIm.im, this.bufIm),
      };
    }
  }

  // ---------------------------------------------------------------------------
  // Mixers.pas (TModulator — Mixes filtered I/Q baseband to CW audio Pitch)
  // ---------------------------------------------------------------------------
  class Modulator {
    constructor(samplesPerSec = DEFAULTRATE, carrierFreq = 600) {
      this.samplesPerSec = samplesPerSec;
      this.carrierFreq = carrierFreq;
      this.phase = 0.0;
    }

    setCarrierFreq(freq) {
      this.carrierFreq = freq;
    }

    modulate(reIm) {
      const len = reIm.re.length;
      const out = new Float32Array(len);
      const dPhi = (TWO_PI * this.carrierFreq) / this.samplesPerSec;
      for (let i = 0; i < len; i++) {
        out[i] = reIm.re[i] * Math.cos(this.phase) - reIm.im[i] * Math.sin(this.phase);
        this.phase += dPhi;
        if (this.phase > TWO_PI) this.phase -= TWO_PI;
      }
      return out;
    }
  }

  // ---------------------------------------------------------------------------
  // VolumCtl.pas (VE3NEA Windowed Log-Magnitude Attack/Hold Receiver AGC)
  // ---------------------------------------------------------------------------
  class VolumeControl {
    constructor(attackSamples = 155, holdSamples = 155) {
      this.maxOut = 20000.0;
      this.noiseIn = Math.pow(10, 0.05 * 76);
      this.noiseOut = Math.min(0.25 * this.maxOut, Math.pow(10, 0.05 * 76));
      this.attackSamples = attackSamples;
      this.holdSamples = holdSamples;
      this.agcEnabled = true;
      this.lastGainReductionDb = 0.0;
      this.calcBeta();
      this.makeAttackShape();
    }

    calcBeta() {
      this.beta = this.noiseIn / Math.log(this.maxOut / (this.maxOut - this.noiseOut));
      this.defaultGain = this.noiseOut / this.noiseIn;
    }

    makeAttackShape() {
      this.len = 2 * (this.attackSamples + this.holdSamples) + 1;
      this.attackShape = new Float32Array(this.len);
      for (let i = 0; i < this.attackSamples; i++) {
        const v = Math.log(0.5 - 0.5 * Math.cos(((i + 1) * Math.PI) / (this.attackSamples + 1)));
        this.attackShape[i] = v;
        this.attackShape[this.len - 1 - i] = v;
      }
      this.reset();
    }

    reset() {
      this.realBuf = new Float32Array(this.len);
      this.magBuf = new Float32Array(this.len);
      this.bufIdx = 0;
    }

    process(data) {
      const n = data.length;
      const out = new Float32Array(n);
      if (!this.agcEnabled) {
        for (let i = 0; i < n; i++) {
          out[i] = Math.max(-this.maxOut, Math.min(this.maxOut, data[i] * this.defaultGain));
        }
        this.lastGainReductionDb = 0;
        return out;
      }

      const halfLen = this.len >> 1;
      let minGain = 1.0;

      for (let i = 0; i < n; i++) {
        const v = data[i];
        this.realBuf[this.bufIdx] = v;
        this.magBuf[this.bufIdx] = Math.log(Math.abs(v) + 1e-10);
        this.bufIdx = (this.bufIdx + 1) % this.len;

        // Find weighted peak in window (stride 3 optimization keeps exact envelope shape)
        let envel = -23.0;
        let di = this.bufIdx;
        for (let wi = 0; wi < this.len; wi += 3) {
          const sample = this.magBuf[di] + this.attackShape[wi];
          if (sample > envel) envel = sample;
          di += 3;
          if (di >= this.len) di -= this.len;
        }

        const linEnv = Math.exp(envel);
        const gain = (this.maxOut * (1.0 - Math.exp(-linEnv / this.beta))) / linEnv;
        if (gain < minGain) minGain = gain;

        const midIdx = (this.bufIdx + halfLen) % this.len;
        out[i] = this.realBuf[midIdx] * gain;
      }

      this.lastGainReductionDb = Math.max(0, Math.min(40, -20 * Math.log10(Math.max(0.01, minGain))));
      return out;
    }
  }

  return {
    DEFAULTRATE,
    DEFAULTBUFSIZE,
    TWO_PI,
    NEVER,
    rndNormal,
    rndGaussLim,
    rndRayleigh,
    rndUniform,
    rndUShaped,
    rndPoisson,
    secondsToBlocks,
    blocksToSeconds,
    calculateCRC32,
    MorseKeyer,
    QuickAverage,
    Qsb,
    MovingAverage,
    Modulator,
    VolumeControl,
  };
})();

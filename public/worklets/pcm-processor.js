// Encodes mic to PCM16 @16k in 20ms frames (320 samples)
class PCMEncoderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(0);     // float audio at ctx rate
    this._targetRate = 16000;
    this._ratio = sampleRate / this._targetRate;
    this._carry = 0;                      // fractional read position
    this._outBuf = new Float32Array(0);   // resampled @16k
  }

  _appendFloat(a, b) {
    const out = new Float32Array(a.length + b.length);
    out.set(a, 0); out.set(b, a.length);
    return out;
  }

  _resampleTo16k() {
    if (!this._buf.length) return;
    const inBuf = this._buf;
    const outLen = Math.floor((inBuf.length - 1 - this._carry) / this._ratio);
    if (outLen <= 0) return;

    const out = new Float32Array(outLen);
    let pos = this._carry;
    for (let i = 0; i < outLen; i++) {
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const s0 = inBuf[idx];
      const s1 = inBuf[idx + 1] ?? s0;
      out[i] = s0 + (s1 - s0) * frac;
      pos += this._ratio;
    }
    this._carry = pos % 1;

    // keep the unread tail in _buf
    const consumed = Math.floor(pos);
    this._buf = inBuf.subarray(consumed);

    // append to accumulated 16k stream
    this._outBuf = this._appendFloat(this._outBuf, out);
  }

  _flushFrames() {
    const SAMPLES_PER_FRAME = 320; // 20ms @16k
    while (this._outBuf.length >= SAMPLES_PER_FRAME) {
      const frame = this._outBuf.subarray(0, SAMPLES_PER_FRAME);
      this._outBuf = this._outBuf.subarray(SAMPLES_PER_FRAME);

      // float32 -> int16 little-endian
      const pcm16 = new Int16Array(frame.length);
      for (let i = 0; i < frame.length; i++) {
        let s = Math.max(-1, Math.min(1, frame[i]));
        pcm16[i] = (s < 0 ? s * 0x8000 : s * 0x7fff) | 0;
      }
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }
  }

  process(inputs) {
    const ch0 = inputs[0] && inputs[0][0];
    if (ch0 && ch0.length) {
      // append fresh mic samples at ctx sampleRate
      this._buf = this._appendFloat(this._buf, ch0);
      this._resampleTo16k();
      this._flushFrames();
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMEncoderProcessor);

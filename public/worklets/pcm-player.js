// Buffers Float32 chunks (already at ctx sampleRate) and plays them
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.port.onmessage = (e) => {
      const f32 = new Float32Array(e.data);
      this.queue.push(f32);
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0][0];
    let i = 0;
    while (i < out.length) {
      if (!this.queue.length) break;
      const cur = this.queue[0];
      const remainInCur = cur.length - this.offset;
      const need = out.length - i;
      const take = Math.min(remainInCur, need);
      out.set(cur.subarray(this.offset, this.offset + take), i);
      this.offset += take;
      i += take;
      if (this.offset >= cur.length) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    // pad with silence
    for (; i < out.length; i++) out[i] = 0;
    return true;
  }
}

registerProcessor('pcm-player', PCMPlayerProcessor);

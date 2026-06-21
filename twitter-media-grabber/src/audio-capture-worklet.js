/*
 * AudioWorklet processor for live tab-audio capture. This is the modern,
 * non-deprecated replacement for ScriptProcessorNode: it runs on the audio
 * render thread, accumulates incoming mono samples into fixed-size blocks and
 * transfers each completed block to the offscreen document, which windows and
 * transcribes it.
 */
const BLOCK = 4096;

class TmgCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Float32Array(BLOCK);
    this._n = 0;
  }

  process(inputs) {
    // Single input, downmixed to mono by the node's channel settings.
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) {
        this._buf[this._n++] = ch[i];
        if (this._n === BLOCK) {
          // Transfer the buffer (zero-copy) and start a fresh one.
          this.port.postMessage(this._buf, [this._buf.buffer]);
          this._buf = new Float32Array(BLOCK);
          this._n = 0;
        }
      }
    }
    return true; // keep the processor alive for the life of the node
  }
}

registerProcessor('tmg-capture', TmgCaptureProcessor);

// ================= DEBUG AUDIO =================

function pcm16Stats(buf) {
  const samples = Math.floor(buf.length / 2);
  let min = 32767, max = -32768;
  let sumSq = 0;
  let peak = 0;

  for (let i = 0; i < samples; i++) {
    const v = buf.readInt16LE(i * 2);
    if (v < min) min = v;
    if (v > max) max = v;

    const f = v / 32768;
    sumSq += f * f;
    const a = Math.abs(f);
    if (a > peak) peak = a;
  }

  const rms = Math.sqrt(sumSq / Math.max(1, samples));
  return { samples, min, max, rms, peak };
}

function wavHeader({ sampleRate, numChannels, bitsPerSample, dataBytes }) {
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const buffer = Buffer.alloc(44);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);

  return buffer;
}

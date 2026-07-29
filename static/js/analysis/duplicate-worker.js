const CHUNK_BYTES = 4 * 1024 * 1024;

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

class IncrementalSha256 {
  constructor() {
    this.state = new Uint32Array([
      0x6a09e667,
      0xbb67ae85,
      0x3c6ef372,
      0xa54ff53a,
      0x510e527f,
      0x9b05688c,
      0x1f83d9ab,
      0x5be0cd19,
    ]);
    this.buffer = new Uint8Array(64);
    this.bufferLength = 0;
    this.bytesHashed = 0;
    this.finished = false;
    this.schedule = new Uint32Array(64);
  }

  update(input) {
    if (this.finished) {
      throw new Error("SHA-256は既に確定しています。");
    }
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    this.bytesHashed += bytes.length;
    let position = 0;
    while (position < bytes.length) {
      const take = Math.min(64 - this.bufferLength, bytes.length - position);
      this.buffer.set(bytes.subarray(position, position + take), this.bufferLength);
      this.bufferLength += take;
      position += take;
      if (this.bufferLength === 64) {
        this.processBlock(this.buffer);
        this.bufferLength = 0;
      }
    }
    return this;
  }

  processBlock(block) {
    const words = this.schedule;
    for (let index = 0; index < 16; index += 1) {
      const offset = index * 4;
      words[index] = (
        (block[offset] << 24)
        | (block[offset + 1] << 16)
        | (block[offset + 2] << 8)
        | block[offset + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const word15 = words[index - 15];
      const word2 = words[index - 2];
      const sigma0 = rotateRight(word15, 7) ^ rotateRight(word15, 18) ^ (word15 >>> 3);
      const sigma1 = rotateRight(word2, 17) ^ rotateRight(word2, 19) ^ (word2 >>> 10);
      words[index] = (words[index - 16] + sigma0 + words[index - 7] + sigma1) >>> 0;
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];
    let f = this.state[5];
    let g = this.state[6];
    let h = this.state[7];
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + SHA256_K[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
    this.state[5] = (this.state[5] + f) >>> 0;
    this.state[6] = (this.state[6] + g) >>> 0;
    this.state[7] = (this.state[7] + h) >>> 0;
  }

  digestHex() {
    if (!this.finished) {
      const finalBlock = new Uint8Array(128);
      finalBlock.set(this.buffer.subarray(0, this.bufferLength));
      finalBlock[this.bufferLength] = 0x80;
      const lengthOffset = this.bufferLength < 56 ? 56 : 120;
      const high = Math.floor(this.bytesHashed / 0x20000000);
      const low = (this.bytesHashed << 3) >>> 0;
      finalBlock[lengthOffset] = (high >>> 24) & 0xff;
      finalBlock[lengthOffset + 1] = (high >>> 16) & 0xff;
      finalBlock[lengthOffset + 2] = (high >>> 8) & 0xff;
      finalBlock[lengthOffset + 3] = high & 0xff;
      finalBlock[lengthOffset + 4] = (low >>> 24) & 0xff;
      finalBlock[lengthOffset + 5] = (low >>> 16) & 0xff;
      finalBlock[lengthOffset + 6] = (low >>> 8) & 0xff;
      finalBlock[lengthOffset + 7] = low & 0xff;
      this.processBlock(finalBlock.subarray(0, 64));
      if (lengthOffset === 120) {
        this.processBlock(finalBlock.subarray(64, 128));
      }
      this.finished = true;
    }
    return [...this.state]
      .map((word) => word.toString(16).padStart(8, "0"))
      .join("");
  }
}

const cancelled = new Set();

async function hashFile(task, requestId, progress) {
  const sha = new IncrementalSha256();
  const file = task.file;
  let offset = 0;
  while (offset < file.size) {
    if (cancelled.has(requestId)) {
      const error = new Error("精密確認をキャンセルしました。");
      error.name = "AbortError";
      throw error;
    }
    const end = Math.min(file.size, offset + CHUNK_BYTES);
    const bytes = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    sha.update(bytes);
    offset = end;
    progress(offset);
  }
  if (file.size === 0) {
    progress(0);
  }
  return sha.digestHex();
}

self.addEventListener("message", async (event) => {
  const message = event.data || {};
  const requestId = String(message.requestId || "");
  if (message.type === "cancel") {
    cancelled.add(requestId);
    return;
  }
  if (message.type !== "hash" || !requestId) {
    return;
  }

  const tasks = Array.isArray(message.tasks) ? message.tasks : [];
  const totalBytes = tasks.reduce((sum, task) => sum + Math.max(0, Number(task.file?.size) || 0), 0);
  const results = [];
  let completedBytes = 0;
  let completedFiles = 0;
  cancelled.delete(requestId);
  try {
    for (const task of tasks) {
      const fileSize = Math.max(0, Number(task.file?.size) || 0);
      let lastFileBytes = 0;
      try {
        const hash = await hashFile(task, requestId, (fileBytes) => {
          const delta = Math.max(0, fileBytes - lastFileBytes);
          lastFileBytes = fileBytes;
          self.postMessage({
            type: "progress",
            requestId,
            completedBytes: completedBytes + fileBytes,
            totalBytes,
            completedFiles,
            totalFiles: tasks.length,
            currentPath: String(task.relativePath || ""),
            deltaBytes: delta,
          });
        });
        completedBytes += fileSize;
        completedFiles += 1;
        results.push({
          id: task.id,
          relativePath: String(task.relativePath || ""),
          size: fileSize,
          hash,
          error: null,
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          throw error;
        }
        completedBytes += fileSize;
        completedFiles += 1;
        results.push({
          id: task.id,
          relativePath: String(task.relativePath || ""),
          size: fileSize,
          hash: null,
          error: "このファイルのハッシュを計算できませんでした。",
        });
      }
    }
    self.postMessage({ type: "result", requestId, results, totalBytes });
  } catch (error) {
    self.postMessage({
      type: error?.name === "AbortError" ? "cancelled" : "error",
      requestId,
      message: error?.name === "AbortError"
        ? "精密確認をキャンセルしました。"
        : "SHA-256の計算中にエラーが発生しました。",
    });
  } finally {
    cancelled.delete(requestId);
  }
});

export { IncrementalSha256 };

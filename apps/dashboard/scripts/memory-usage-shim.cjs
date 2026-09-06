"use strict";

// Some restricted workspace runtimes deny the platform call behind
// process.memoryUsage.rss(). Next.js uses it only for build telemetry and
// worker heuristics, so preserve the native values whenever available and
// provide a zero-valued fallback instead of making a production build crash.
const nativeMemoryUsage = process.memoryUsage.bind(process);

function safeMemoryUsage() {
  try {
    return nativeMemoryUsage();
  } catch {
    return {
      rss: 0,
      heapTotal: 0,
      heapUsed: 0,
      external: 0,
      arrayBuffers: 0,
    };
  }
}

safeMemoryUsage.rss = () => {
  try {
    return nativeMemoryUsage.rss();
  } catch {
    return 0;
  }
};

process.memoryUsage = safeMemoryUsage;

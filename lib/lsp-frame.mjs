// LSP framing: Content-Length headers over a duplex stream.
import { Buffer } from "node:buffer";

export function makeFramer(onMessage) {
  let buf = Buffer.alloc(0);
  return (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const hdrEnd = buf.indexOf("\r\n\r\n");
      if (hdrEnd < 0) return;
      const header = buf.slice(0, hdrEnd).toString("utf8");
      const m = header.match(/Content-Length:\s*(\d+)/i);
      if (!m) { buf = buf.slice(hdrEnd + 4); continue; }
      const len = parseInt(m[1], 10);
      if (buf.length < hdrEnd + 4 + len) return;
      const body = buf.slice(hdrEnd + 4, hdrEnd + 4 + len).toString("utf8");
      buf = buf.slice(hdrEnd + 4 + len);
      try { onMessage(JSON.parse(body)); } catch { /* skip */ }
    }
  };
}

export function frame(obj) {
  const body = JSON.stringify(obj);
  return `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
}

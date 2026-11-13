/**
 * The base64 text of `bytes` on one line. Browsers that have the native
 * `Uint8Array.prototype.toBase64` use it; elsewhere, Node before version 25
 * among them, the text is built from `btoa` in slices, which keeps each
 * argument list short. The browser encodes images with it before Run sends
 * them (`withImages` in `src/ui/attachments.ts`); it lives apart from the UI
 * so the Worker's tests can build the same text without the DOM.
 */
export function encodeBase64(bytes: Uint8Array): string {
  // Typed as optional on purpose: an older browser lacks the method.
  const native = (bytes as Uint8Array & { toBase64?: () => string }).toBase64;
  if (typeof native === "function") return native.call(bytes);
  const slice = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += slice) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + slice));
  }
  return btoa(binary);
}

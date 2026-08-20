const crypto = require('crypto')

// Node 16: crypto.getRandomValues doesn't exist on the default export,
// but crypto.webcrypto.getRandomValues does. Vite imports crypto$2 from
// 'node:crypto' and calls crypto$2.getRandomValues(), so we must patch
// the module default export directly.
if (!crypto.getRandomValues && crypto.webcrypto) {
  crypto.getRandomValues = crypto.webcrypto.getRandomValues.bind(crypto.webcrypto)
}

// Also patch globalThis.crypto for any code that uses it
if (!globalThis.crypto) {
  globalThis.crypto = {}
}
if (!globalThis.crypto.getRandomValues) {
  globalThis.crypto.getRandomValues = crypto.getRandomValues
}
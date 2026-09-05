#!/usr/bin/env node

// npm launches this plain-JavaScript shim on every supported platform. The implementation
// is compiled to dist before packing, so installed users do not need TypeScript or Node's
// experimental type-stripping flag.
await import("../dist/cli/main.js");

# ADR 0002 — A plain ES-module web client and in-repo Markdown and Org parsers

## Status
Accepted

## Context
The vault needs a fast, good-looking web client that also installs as an app and works on a
phone. The repository keeps runtime dependencies to a minimum and has no bundler. Pages are
written by agents and must be treated as untrusted.

## Decision
1. The client is plain TypeScript ES modules under `web/`, no framework and no bundler. The
   server serves `.ts` files as JavaScript after `node:module`'s `stripTypeScriptTypes`. DOM is
   built with a small `h()` helper; nothing assigns HTML.
2. Markdown is parsed by `src/vault/markdown.ts`, and Org by `src/vault/org.ts`, into the same
   node tree with source line ranges; the client turns nodes into DOM with text nodes and
   attributes only. Raw HTML stays text.
3. PDFs use `pdfjs-dist`, a regular dependency imported only when a PDF opens and excluded from
   the client size budget.
4. If keyed-list code in the client grows past a few hundred lines, Preact with htm served as
   static ESM is allowed without a bundler, with a note in this ADR.

## Consequences
- No HTML injection class exists to defend (CONTRACT_TESTS #3, enforced by a static scan of
  `web/`).
- A library parser (mdast-util-from-markdown) was considered by reviewers; it would add about
  thirty packages and still need source mapping. Revisit on compatibility bugs.
- The installed package ships `web/`, the compiled parsers and the demo vault; runtime type
  stripping needs Node 22.13 or later.

// Vendored from dsh-oc-tui (https://github.com/rayafriandion/dsh-oc-tui), MIT License.
// Copyright (c) 2026 rayafriandion. Adapted for habor.
// Minimal markdown -> styled terminal lines. Each line is an array of
// { text, style } segments. Not a full spec implementation: covers the block
// shapes and inline spans most model output uses, and degrades gracefully.
import { makeStyle, mergeStyle } from './term.js'
import { runeWidth, graphemes, displayWidth } from './util.js'

// Parse inline markdown into styled segments. `base` is merged into each.
// Handles **bold**, *italic*, `code`, [text](url), and ~~strike~~.
export function inlineSegments(text, theme, base = null) {
  const segments = []
  const buf = []
  const inherited = (style) => base ? {
    ...mergeStyle(base, style),
    bold: base.bold || style.bold,
    italic: base.italic || style.italic,
    dim: base.dim || style.dim,
    underline: base.underline || style.underline,
  } : style
  const flush = (style) => {
    if (buf.length === 0) return
    segments.push({ text: buf.join(''), style: inherited(style) })
    buf.length = 0
  }
  const plain = () => flush(makeStyle({ fg: theme.text }))
  let i = 0
  const n = text.length
  while (i < n) {
    const rest = text.slice(i)
    // code span
    if (rest.startsWith('`')) {
      plain()
      let j = i + 1
      let code = ''
      let closed = false
      while (j < n) {
        if (text[j] === '`') { closed = true; break }
        code += text[j]
        j++
      }
      if (closed) {
        flush(makeStyle({ fg: theme.markdownCode }))
        segments.push({ text: code, style: inherited(makeStyle({ fg: theme.markdownCode, bg: theme.codeBg })) })
        i = j + 1
        continue
      }
      buf.push('`')
      i += 1
      continue
    }
    // bold
    if (rest.startsWith('**')) {
      plain()
      const end = text.indexOf('**', i + 2)
      if (end !== -1) {
        flush(makeStyle({ fg: theme.text, bold: true }))
        const inner = inlineSegments(text.slice(i + 2, end), theme, makeStyle({ bold: true }))
        for (const seg of inner) segments.push(seg)
        i = end + 2
        continue
      }
    }
    // italic
    if (rest.startsWith('*')) {
      plain()
      const end = text.indexOf('*', i + 1)
      if (end !== -1) {
        flush(makeStyle({ fg: theme.text, italic: true }))
        const inner = inlineSegments(text.slice(i + 1, end), theme, makeStyle({ italic: true }))
        for (const seg of inner) segments.push(seg)
        i = end + 1
        continue
      }
    }
    // link [text](url)
    if (rest.startsWith('[')) {
      const close = text.indexOf(']', i)
      if (close !== -1 && text[close + 1] === '(') {
        const urlEnd = text.indexOf(')', close + 2)
        if (urlEnd !== -1) {
          plain()
          const label = text.slice(i + 1, close)
          segments.push({ text: label, style: inherited(makeStyle({ fg: theme.markdownLinkText, underline: true })) })
          i = urlEnd + 1
          continue
        }
      }
    }
    // strike
    if (rest.startsWith('~~')) {
      const end = text.indexOf('~~', i + 2)
      if (end !== -1) {
        plain()
        flush(makeStyle({ fg: theme.text, dim: true }))
        const inner = inlineSegments(text.slice(i + 2, end), theme, makeStyle({ dim: true }))
        for (const seg of inner) segments.push(seg)
        i = end + 2
        continue
      }
    }
    // A backslash is literal text (Windows paths keep their separators).
    buf.push(text[i])
    i += 1
  }
  flush(makeStyle({ fg: theme.text }))
  return segments
}

// Wrap inline segments to `width` cells, returning lines of segments.
export function wrapSegments(segments, width) {
  if (width <= 0) return [[]]
  const lines = []
  let row = [], cells = 0
  const flush = () => { lines.push(row); row = []; cells = 0 }
  for (const segment of segments) {
    for (const word of segment.text.split(/(\s+)/)) {
      if (!word) continue
      const wordWidth = displayWidth(word)
      if (!/^\s+$/.test(word) && wordWidth <= width && cells && cells + wordWidth > width) flush()
      for (const glyph of graphemes(word)) {
        const w = runeWidth(glyph)
        if (cells && cells + w > width) flush()
        const text = w > width ? '�' : glyph
        const last = row.at(-1)
        if (last?.style === segment.style) last.text += text
        else row.push({ text, style: segment.style })
        cells += Math.min(w, width)
      }
    }
  }
  if (row.length || !lines.length) lines.push(row)
  return lines
}

const CODE_BG = '1e1e1e'

// Render markdown text to styled lines for the given width.
// Returns an array of lines; each line is an array of { text, style }.
export function renderMarkdown(text, theme, width) {
  const lines = []
  const raw = String(text).replace(/\r\n/g, '\n')
  const blockLines = raw.split('\n')
  let i = 0
  let inCode = false
  while (i < blockLines.length) {
    const line = blockLines[i]
    if (inCode) {
      if (/^```/.test(line.trim())) {
        inCode = false
        lines.push([])
        i++
        continue
      }
      const segs = [{ text: line, style: makeStyle({ fg: theme.markdownCodeBlock, bg: theme.codeBg ?? CODE_BG }) }]
      pushWrapped(lines, segs, width)
      i++
      continue
    }
    const trimmed = line.trim()
    const fence = /^```(\S*)/.exec(trimmed)
    if (fence) {
      inCode = true
      pushWrapped(lines, [{ text: '┌ ' + (fence[1] || 'code'), style: makeStyle({ fg: theme.textMuted, bg: theme.codeBg }) }], width)
      i++
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(trimmed)
    if (h) {
      pushWrapped(lines, [{ text: h[2], style: makeStyle({ fg: theme.markdownHeading, bold: true }) }], width)
      i++
      continue
    }
    if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) {
      lines.push([{ text: '─'.repeat(Math.max(0, width)), style: makeStyle({ fg: theme.markdownHorizontalRule, dim: true }) }])
      i++
      continue
    }
    const q = /^>\s?(.*)$/.exec(line)
    if (q) {
      const segs = [{ text: '▍ ', style: makeStyle({ fg: theme.markdownBlockQuote }) }]
      segs.push(...inlineSegments(q[1], theme, makeStyle({ fg: theme.markdownBlockQuote })))
      pushWrapped(lines, segs, width)
      i++
      continue
    }
    const li = /^([-*+]|\d+\.)\s+(.*)$/.exec(trimmed)
    if (li) {
      const marker = /^\d/.test(li[1]) ? ' ' + li[1] + ' ' : '- '
      const prefix = [{ text: marker, style: makeStyle({ fg: theme.markdownListItem, bold: true }) }]
      prefix.push(...inlineSegments(li[2], theme))
      pushWrapped(lines, prefix, width)
      i++
      continue
    }
    if (trimmed === '') {
      lines.push([])
      i++
      continue
    }
    let para = line
    while (i + 1 < blockLines.length && !startsNewBlock(blockLines[i + 1])) {
      i++
      para += ' ' + blockLines[i]
    }
    pushWrapped(lines, inlineSegments(para, theme), width)
    i++
  }
  return lines
}

// Whether a raw line begins a block that must not merge into the paragraph
// above it: blank, list item, blockquote, fence, heading, or horizontal rule.
function startsNewBlock(raw) {
  const trimmed = raw.trim()
  if (trimmed === '') return true
  if (/^```/.test(trimmed)) return true
  if (/^#{1,4}\s/.test(trimmed)) return true
  if (/^([-*+]|\d+\.)\s/.test(trimmed)) return true
  if (/^>\s?/.test(trimmed)) return true
  if (/^(---|\*\*\*|___)\s*$/.test(trimmed)) return true
  return false
}

function pushWrapped(out, segments, width) {
  for (const line of wrapSegments(segments, width)) {
    out.push(line.length === 0 ? [] : line)
  }
}

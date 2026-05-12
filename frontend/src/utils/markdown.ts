import { marked } from 'marked'
import DOMPurify from 'dompurify'

// Configure marked for safe rendering
marked.setOptions({
  breaks: true, // Convert \n to <br>
  gfm: true     // GitHub Flavored Markdown
})

// Allow @mention spans we emit ourselves; block everything dangerous. We
// don't permit form elements, raw scripts, event handlers, or javascript:
// URIs. The default DOMPurify config blocks <script>, <iframe>, on* attrs,
// and most XSS vectors out of the box; we tighten it further.
const PURIFY_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS: [
    'p', 'br', 'hr',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'strong', 'em', 'b', 'i', 'u', 's', 'del', 'ins', 'mark',
    'a',
    'ul', 'ol', 'li',
    'blockquote',
    'code', 'pre',
    'table', 'thead', 'tbody', 'tr', 'th', 'td',
    'span',
  ],
  ALLOWED_ATTR: ['href', 'title', 'class'],
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
  FORBID_ATTR: ['style', 'srcset'],
}

/**
 * Escape HTML-like patterns that aren't valid HTML tags
 * This prevents things like <reply:@user> or <end of turn> from being parsed as HTML
 */
function escapeNonHtmlTags(text: string): string {
  // Match < followed by anything that's NOT a valid HTML tag start
  // Valid HTML tags start with a letter or / (for closing tags)
  // We want to escape things like <reply:, <end of, etc.
  return text.replace(/<(?![a-zA-Z\/!])/g, '&lt;')
    // Also escape patterns like <word followed by : or space (not valid HTML)
    .replace(/<([a-zA-Z]+)(?=[:@\s][^>]*>)/g, '&lt;$1')
    // Escape any remaining unclosed angle brackets that look like chat artifacts
    .replace(/<(reply|end|start|user|assistant|system|thinking|context|message)[^>]*>/gi, (match) => {
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    })
}

/**
 * Convert Discord-style mentions to styled badges
 * Handles: <@username>, <@user name>, @username
 * Note: reply:@username patterns are now handled in Message.vue header, not here
 */
function styleMentions(html: string): string {
  // Handle <@username> or <@user name> patterns (use a placeholder to avoid double-matching)
  html = html.replace(/&lt;@([^&]+)&gt;/g, '%%MENTION%%$1%%ENDMENTION%%')
  
  // Handle standalone @mentions (but not in code blocks, emails, or already-processed mentions)
  // Only match @word patterns not preceded by letters/numbers (to avoid emails)
  html = html.replace(/(?<![a-zA-Z0-9%])@([a-zA-Z][a-zA-Z0-9_]{1,30})(?![a-zA-Z0-9@%])/g, '%%MENTION%%$1%%ENDMENTION%%')
  
  // Now convert placeholders to actual spans
  html = html.replace(/%%MENTION%%([^%]+)%%ENDMENTION%%/g, '<span class="mention">@$1</span>')
  
  return html
}

/**
 * Render markdown to HTML, sanitizing against XSS.
 *
 * The pipeline is:
 *   1. Escape chat-style pseudo-tags (<reply:user>, <end of turn>, etc.) so
 *      marked doesn't try to interpret them as HTML.
 *   2. Run marked to produce HTML.
 *   3. Run DOMPurify to strip anything dangerous (script tags, on* handlers,
 *      javascript: URIs, etc.). Without this step, user-submitted content
 *      like <img src=x onerror="..."> would execute in other users' browsers.
 *   4. Apply our @mention styling.
 */
export function renderMarkdown(text: string): string {
  if (!text) return ''
  const escaped = escapeNonHtmlTags(text)
  const rawHtml = marked.parse(escaped) as string
  const safeHtml = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG)
  return styleMentions(safeHtml)
}

/**
 * For plain text that should preserve newlines but isn't markdown
 */
export function preserveNewlines(text: string): string {
  if (!text) return ''
  return text.replace(/\n/g, '<br>')
}


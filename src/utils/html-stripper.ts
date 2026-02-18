/**
 * Strip HTML tags, convert to plain text, and optionally truncate.
 * Mirrors the logic from helpscout-claude/utils/helpers.py strip_html()
 */
export function stripHtml(html: string, maxLength?: number): string {
  if (!html) return '';

  let text = html;

  // Remove HTML-level quoted content BEFORE stripping tags.
  // Email clients wrap quoted replies in <blockquote>, gmail_quote divs, etc.
  // We strip from the first quote marker to end-of-string since everything
  // after is the forwarded/replied original message.
  const htmlQuotePatterns = [
    /<blockquote[^>]*>[\s\S]*$/i,
    /<div\s[^>]*class="[^"]*gmail_quote[^"]*"[^>]*>[\s\S]*$/i,
    /<div\s[^>]*id="appendonsend"[^>]*>[\s\S]*$/i,
    /<div\s[^>]*class="[^"]*yahoo_quoted[^"]*"[^>]*>[\s\S]*$/i,
  ];

  for (const pattern of htmlQuotePatterns) {
    const match = text.match(pattern);
    // Only strip if there's some content before the quote (>50 chars of HTML)
    if (match && match.index !== undefined && match.index > 50) {
      text = text.slice(0, match.index);
      break;
    }
  }

  // Convert <br> to newlines
  text = text.replace(/<br\s*\/?>/gi, '\n');

  // Convert closing block tags to newlines
  text = text.replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n');

  // Remove all remaining HTML tags
  text = text.replace(/<[^>]+>/g, '');

  // Decode common HTML entities
  text = text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');

  // Collapse whitespace (but preserve newlines)
  text = text.replace(/[ \t]+/g, ' ');

  // Max 2 consecutive newlines
  text = text.replace(/\n{3,}/g, '\n\n');

  text = text.trim();

  return maxLength ? text.slice(0, maxLength) : text;
}

/**
 * Strip quoted/forwarded email content from plain text.
 * Should be called AFTER stripHtml() to catch text-level quote patterns
 * that weren't wrapped in HTML blockquote elements.
 *
 * Detects:
 * - Explicit forward markers ("---------- Forwarded message ----------")
 * - Forward header blocks in multiple languages (From/Von/De + Date/Datum)
 * - "On [date], [name] wrote:" reply patterns
 */
export function stripQuotedContent(text: string): string {
  if (!text) return '';

  const lines = text.split('\n');
  let cutIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // Pattern 1: Explicit forward markers
    if (/^-{3,}\s*(Forwarded message|Original Message)\s*-{3,}$/i.test(line) ||
        /^Begin forwarded message:\s*$/i.test(line)) {
      cutIndex = i;
      break;
    }

    // Pattern 2: "On ... wrote:" reply patterns (EN/DE/FR)
    if (/^On\s+.{10,100}\s+wrote:\s*$/.test(line) ||
        /^Am\s+.{10,100}\s+schrieb\s+.+:\s*$/.test(line) ||
        /^Le\s+.{10,100}\s+a\s+.+crit\s*:\s*$/i.test(line)) {
      cutIndex = i;
      break;
    }

    // Pattern 3: Forward header block — "Von:"/"From:" followed by "Datum:"/"Date:"
    // within the next 8 lines (allows blank lines between headers)
    if (/^(Von|From|De|Da|Di):\s+.+/i.test(line)) {
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (/^(Datum|Date|Fecha|Data):\s+.+/i.test(nextLine)) {
          cutIndex = i;
          break;
        }
      }
      if (cutIndex !== -1) break;
    }
  }

  if (cutIndex === -1) return text;

  // Only strip if we're keeping some content (at least 10 chars)
  const kept = lines.slice(0, cutIndex).join('\n').trim();
  if (kept.length < 10) return text;

  const removedChars = lines.slice(cutIndex).join('\n').length;
  return kept + `\n\n[Quoted/forwarded content removed - ${removedChars} chars]`;
}

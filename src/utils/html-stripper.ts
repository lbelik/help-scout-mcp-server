export interface InlineImage {
  index: number;       // 1-based position in thread
  src: string;         // URL, cid:, or data: URI
  alt: string;         // alt text (empty string if none)
  width: string | null;
  height: string | null;
  isFetchable: boolean; // true if src is http(s)://
}

/**
 * Extract <img> tags from HTML, replace with [Image N] placeholders.
 * Skips 1x1 tracking pixels. Returns extracted metadata + modified HTML.
 */
export function extractInlineImages(html: string): { images: InlineImage[]; html: string } {
  if (!html) return { images: [], html: '' };

  const images: InlineImage[] = [];
  let imageIndex = 0;

  const modified = html.replace(/<img\b[^>]*>/gi, (tag) => {
    // Extract attributes
    const src = tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1] || '';
    const alt = tag.match(/\balt\s*=\s*["']([^"']*?)["']/i)?.[1] || '';
    const width = tag.match(/\bwidth\s*=\s*["']?(\d+)["']?/i)?.[1] || null;
    const height = tag.match(/\bheight\s*=\s*["']?(\d+)["']?/i)?.[1] || null;

    // Skip 1x1 tracking pixels
    if (width === '1' && height === '1') return '';

    imageIndex++;
    images.push({
      index: imageIndex,
      src,
      alt,
      width,
      height,
      isFetchable: /^https?:\/\//i.test(src),
    });

    const label = alt ? `[Image ${imageIndex}: ${alt}]` : `[Image ${imageIndex}]`;
    return label;
  });

  return { images, html: modified };
}

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
    // Case-SENSITIVE: real email headers are always capitalized
    if (/^(Von|From|De|Da|Di):\s+.+/.test(line)) {
      for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
        const nextLine = lines[j].trim();
        if (/^(Datum|Date|Fecha|Data):\s+.+/.test(nextLine)) {
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

  // Don't strip tiny amounts — likely a false positive, not a real forwarded email
  if (removedChars < 100) return text;

  return kept + `\n\n[Quoted/forwarded content removed - ${removedChars} chars]`;
}

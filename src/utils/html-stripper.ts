/**
 * Strip HTML tags, convert to plain text, and optionally truncate.
 * Mirrors the logic from helpscout-claude/utils/helpers.py strip_html()
 */
export function stripHtml(html: string, maxLength?: number): string {
  if (!html) return '';

  let text = html;

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

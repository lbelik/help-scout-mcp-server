import { extractInlineImages, stripHtml, stripQuotedContent } from '../utils/html-stripper.js';

describe('extractInlineImages', () => {
  it('extracts a single image and replaces with placeholder', () => {
    const html = '<p>Here is my issue:</p><img src="https://example.com/screenshot.png" alt="booking error" width="600" height="400"><p>As you can see above...</p>';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(1);
    expect(result.images[0]).toEqual({
      index: 1,
      src: 'https://example.com/screenshot.png',
      alt: 'booking error',
      width: '600',
      height: '400',
      isFetchable: true,
    });
    expect(result.html).toContain('[Image 1: booking error]');
    expect(result.html).not.toContain('<img');
  });

  it('extracts multiple images with correct indexing', () => {
    const html = '<img src="https://a.com/1.png" alt="first"><p>text</p><img src="https://b.com/2.png" alt="second"><img src="https://c.com/3.png" alt="third">';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(3);
    expect(result.images[0].index).toBe(1);
    expect(result.images[1].index).toBe(2);
    expect(result.images[2].index).toBe(3);
    expect(result.images[0].alt).toBe('first');
    expect(result.images[2].alt).toBe('third');
    expect(result.html).toContain('[Image 1: first]');
    expect(result.html).toContain('[Image 2: second]');
    expect(result.html).toContain('[Image 3: third]');
  });

  it('filters out 1x1 tracking pixels', () => {
    const html = '<img src="https://tracker.com/pixel.gif" width="1" height="1"><img src="https://example.com/real.png" alt="real">';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(1);
    expect(result.images[0].src).toBe('https://example.com/real.png');
    expect(result.images[0].index).toBe(1);
    // Tracking pixel should be removed entirely
    expect(result.html).not.toContain('tracker.com');
  });

  it('marks cid: sources as not fetchable', () => {
    const html = '<img src="cid:image001.png@01D1A2B3" alt="embedded">';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(1);
    expect(result.images[0].src).toBe('cid:image001.png@01D1A2B3');
    expect(result.images[0].isFetchable).toBe(false);
  });

  it('marks data: URIs as not fetchable', () => {
    const html = '<img src="data:image/png;base64,iVBOR..." alt="inline">';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(1);
    expect(result.images[0].src).toBe('data:image/png;base64,iVBOR...');
    expect(result.images[0].isFetchable).toBe(false);
  });

  it('handles empty/missing alt text', () => {
    const html = '<img src="https://example.com/no-alt.png">';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(1);
    expect(result.images[0].alt).toBe('');
    expect(result.html).toContain('[Image 1]');
    expect(result.html).not.toContain('[Image 1: ]');
  });

  it('handles alt="" (explicit empty)', () => {
    const html = '<img src="https://example.com/empty-alt.png" alt="">';
    const result = extractInlineImages(html);

    expect(result.images[0].alt).toBe('');
    expect(result.html).toContain('[Image 1]');
  });

  it('returns empty array and unchanged html when no images', () => {
    const html = '<p>No images here</p><div>Just text</div>';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(0);
    expect(result.html).toBe(html);
  });

  it('handles empty string input', () => {
    const result = extractInlineImages('');
    expect(result.images).toHaveLength(0);
    expect(result.html).toBe('');
  });

  it('handles null-ish width/height', () => {
    const html = '<img src="https://example.com/img.png" alt="no dims">';
    const result = extractInlineImages(html);

    expect(result.images[0].width).toBeNull();
    expect(result.images[0].height).toBeNull();
  });

  it('handles self-closing img tags', () => {
    const html = '<img src="https://example.com/self.png" alt="self" />';
    const result = extractInlineImages(html);

    expect(result.images).toHaveLength(1);
    expect(result.images[0].src).toBe('https://example.com/self.png');
  });

  it('integration: extractInlineImages + stripHtml produce clean text with placeholders', () => {
    const html = '<p>Here is my issue:</p><img src="https://example.com/screenshot.png" alt="booking error" width="600" height="400"><p>As you can see above, the date is wrong.</p>';

    const extracted = extractInlineImages(html);
    const text = stripHtml(extracted.html);

    expect(text).toContain('[Image 1: booking error]');
    expect(text).toContain('Here is my issue:');
    expect(text).toContain('the date is wrong.');
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
  });

  it('integration: full pipeline with stripQuotedContent', () => {
    const html = '<p>See this bug:</p><img src="https://example.com/bug.png" alt="bug screenshot"><blockquote>Previous email content here that is long enough to be stripped from the output entirely</blockquote>';

    const extracted = extractInlineImages(html);
    let text = stripHtml(extracted.html);
    text = stripQuotedContent(text);

    expect(text).toContain('[Image 1: bug screenshot]');
    expect(text).toContain('See this bug:');
    expect(extracted.images).toHaveLength(1);
  });
});

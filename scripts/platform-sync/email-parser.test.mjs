import { describe, expect, it } from 'vitest';
import { parsePlatformEmail } from './email-parser.mjs';

describe('parsePlatformEmail', () => {
  it('parses Sun.store message with negotiation id and product ref', () => {
    const subject = 'Inbox notification: a new sun.store message for negotiations [#wpT5sgv0] awaits you!';
    const text = `
      You've received the following message:
      Based on the details provided by the seller, your goods will be ready for sending in 6 day(s).
      This message regards the negotiations #wpT5sgv0 with the following products:
      Huawei SUN2000-12K-MAP0.
    `;

    const result = parsePlatformEmail({
      fromEmail: 'no-reply@sun.store',
      subject,
      text,
    });

    expect(result.channel).toBe('Sun.store');
    expect(result.negotiationId).toBe('wpT5sgv0');
    expect(result.productRefs).toContain('SUN2000-12K-MAP0');
    expect(result.readyInDays).toBe(6);
    expect(result.errors).toEqual([]);
    expect(result.confidence).toBe(1);
  });

  it('parses Solartraders message with multiple references', () => {
    const result = parsePlatformEmail({
      fromEmail: 'noreply@solartraders.com',
      subject: 'Order update #STA9919',
      text: 'Products: LUNA2000-5-E0, SUN2000-10K-LC0 and DTSU666-H.',
    });

    expect(result.channel).toBe('Solartraders');
    expect(result.negotiationId).toBe('STA9919');
    expect(result.productRefs).toEqual(['LUNA2000-5-E0', 'SUN2000-10K-LC0', 'DTSU666-H']);
    expect(result.errors).toEqual([]);
  });

  it('returns parse errors when negotiation id is missing', () => {
    const result = parsePlatformEmail({
      fromEmail: 'alerts@sun.store',
      subject: 'New message on sun.store',
      text: 'You have a new platform message without order reference.',
    });

    expect(result.channel).toBe('Sun.store');
    expect(result.negotiationId).toBeNull();
    expect(result.errors).toContain('negotiation_id_not_detected');
    expect(result.confidence).toBe(0.35);
  });
});

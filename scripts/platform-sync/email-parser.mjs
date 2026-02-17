const NEGOTIATION_REGEX = /#([A-Za-z0-9]{6,40})\b/g;
const PRODUCT_REF_REGEX = /\b[A-Z0-9]{2,}(?:-[A-Z0-9]{1,}){1,}\b/g;

const TOKEN_BLACKLIST = new Set([
  'DAY-S',
  'DAYS',
  'NO-REPLY',
  'REPLY-ABOVE-THIS-LINE',
  'SUN-STORE',
  'SOLARTRADERS',
  'TRANSACTION',
]);

const normalizeProductRef = (value) => value.replace(/\.+$/, '').trim();

const hasDigit = (value) => /\d/.test(value);

const extractChannel = (subject, body, fromEmail = '') => {
  const haystack = `${fromEmail}\n${subject}\n${body}`.toLowerCase();
  if (haystack.includes('sun.store')) {
    return 'Sun.store';
  }
  if (haystack.includes('solartraders')) {
    return 'Solartraders';
  }
  return null;
};

const extractNegotiationId = (subject, body) => {
  const joined = `${subject}\n${body}`;
  const matches = [...joined.matchAll(NEGOTIATION_REGEX)];
  if (matches.length === 0) {
    return null;
  }
  return matches[0][1];
};

const extractProductRefs = (subject, body) => {
  const joined = `${subject}\n${body}`.toUpperCase();
  const candidates = [...joined.matchAll(PRODUCT_REF_REGEX)]
    .map((match) => normalizeProductRef(match[0]))
    .filter((token) => token.length >= 6)
    .filter((token) => token.length <= 40)
    .filter((token) => hasDigit(token))
    .filter((token) => token.includes('-'))
    .filter((token) => !token.startsWith('OFF-'))
    .filter((token) => !token.includes('-2F'))
    .filter((token) => !token.includes('-3D'))
    .filter((token) => !TOKEN_BLACKLIST.has(token));

  return [...new Set(candidates)];
};

const extractReadyInDays = (body) => {
  const match = body.match(/ready\s+for\s+sending\s+in\s+(\d{1,3})\s+day\(s\)/i);
  if (!match) {
    return null;
  }
  return Number(match[1]);
};

const computeConfidence = ({ channel, negotiationId, productRefs }) => {
  let score = 0;
  if (channel) {
    score += 0.35;
  }
  if (negotiationId) {
    score += 0.4;
  }
  if (productRefs.length > 0) {
    score += 0.25;
  }
  return Number(score.toFixed(3));
};

export const parsePlatformEmail = ({
  fromEmail = '',
  subject = '',
  text = '',
}) => {
  const channel = extractChannel(subject, text, fromEmail);
  const negotiationId = extractNegotiationId(subject, text);
  const productRefs = extractProductRefs(subject, text);
  const readyInDays = extractReadyInDays(text);

  const errors = [];
  if (!channel) {
    errors.push('channel_not_detected');
  }
  if (!negotiationId) {
    errors.push('negotiation_id_not_detected');
  }

  return {
    channel,
    negotiationId,
    productRefs,
    readyInDays,
    confidence: computeConfidence({ channel, negotiationId, productRefs }),
    errors,
  };
};

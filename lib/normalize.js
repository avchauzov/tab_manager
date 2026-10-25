const UNSUPPORTED_PREFIXES = [
  'chrome://',
  'chrome-extension://',
  'moz-extension://',
  'about:',
  'file:',
  'edge://',
  'devtools://',
];

const TRACKING_PARAMS = new Set([
  'fbclid',
  'gclid',
  'dclid',
  'msclkid',
  'yclid',
  'mc_cid',
  'mc_eid',
  'ref_src',
]);

function isTrackingParam(key) {
  return key.startsWith('utm_') || TRACKING_PARAMS.has(key);
}

export function isSupportedUrl(url) {
  if (!url) return false;
  return !UNSUPPORTED_PREFIXES.some((prefix) => url.startsWith(prefix));
}

export function normalizeUrl(url) {
  if (!isSupportedUrl(url)) return null;

  try {
    const parsed = new URL(url);
    parsed.protocol = parsed.protocol.toLowerCase();
    parsed.hostname = parsed.hostname.toLowerCase();
    parsed.hash = '';

    if (
      (parsed.protocol === 'http:' && parsed.port === '80') ||
      (parsed.protocol === 'https:' && parsed.port === '443')
    ) {
      parsed.port = '';
    }

    if (parsed.pathname.length > 1 && parsed.pathname.endsWith('/')) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }

    const kept = [];
    parsed.searchParams.forEach((value, key) => {
      if (!isTrackingParam(key)) {
        kept.push([key, value]);
      }
    });
    kept.sort((a, b) => a[0].localeCompare(b[0]) || a[1].localeCompare(b[1]));

    parsed.search = '';
    for (const [key, value] of kept) {
      parsed.searchParams.append(key, value);
    }

    return parsed.toString();
  } catch {
    return null;
  }
}

export function getHostname(url) {
  if (!isSupportedUrl(url)) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function formatLogUrl(url) {
  const hostname = getHostname(url);
  if (!hostname) return '(unsupported)';
  try {
    const path = new URL(url).pathname || '/';
    return `${hostname}${path}`;
  } catch {
    return hostname;
  }
}

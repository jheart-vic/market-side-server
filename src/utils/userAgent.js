// Best-effort browser + OS label from a User-Agent string, for the session /
// device list. Deliberately dependency-free and coarse — enough for a user to
// recognise "Chrome on Windows" and spot an unfamiliar login.

export function parseUserAgent(ua) {
  const s = String(ua ?? '');
  if (!s) return { browser: 'Unknown', os: 'Unknown', raw: '' };

  const os = /Windows/.test(s)
    ? 'Windows'
    : /iPhone|iPad|iPod/.test(s)
      ? 'iOS'
      : /Mac OS X/.test(s)
        ? 'macOS'
        : /Android/.test(s)
          ? 'Android'
          : /Linux/.test(s)
            ? 'Linux'
            : 'Unknown';

  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\/|Opera/.test(s)
      ? 'Opera'
      : /Chrome\//.test(s)
        ? 'Chrome'
        : /Firefox\//.test(s)
          ? 'Firefox'
          : /Safari\//.test(s)
            ? 'Safari'
            : /node|axios|fetch|Go-http|curl|Postman/i.test(s)
              ? 'API client'
              : 'Unknown';

  return { browser, os, raw: s.slice(0, 200) };
}

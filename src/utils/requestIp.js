/**
 * The real client's public IP for the payment gateway's submit-IP field.
 *
 * Mirrors the sister project's proven `clientIp`: takes the FIRST
 * x-forwarded-for entry (the origin client) rather than Express's `req.ip`,
 * which under a multi-proxy chain can resolve to an intermediate hop — a
 * private/loopback address the gateway rejects with `该ip禁止访问` ("IP
 * forbidden"). Also strips the IPv4-mapped IPv6 prefix (`::ffff:`) so the
 * gateway always receives a clean IPv4.
 */
export function clientIp(req) {
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return (xff || req.ip || '127.0.0.1').replace(/^::ffff:/, '');
}

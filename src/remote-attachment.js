import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const blocked4 = new net.BlockList();
const blocked6 = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10],
  ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.0.2.0", 24], ["192.168.0.0", 16],
  ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
  ["224.0.0.0", 4], ["240.0.0.0", 4]
]) blocked4.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 96], ["::ffff:0:0", 96], ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["100::", 64], ["2001::", 32], ["2001:db8::", 32],
  ["2002::", 16], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]
]) blocked6.addSubnet(address, prefix, "ipv6");

const safeAddress = (address) => {
  const family = net.isIP(address);
  return family !== 0 && !(family === 4 ? blocked4 : blocked6).check(
    address, family === 4 ? "ipv4" : "ipv6"
  );
};

const withinDeadline = (promise, signal) => {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", abort);
    });
  });
};

export const validateRemoteUrl = async (input, resolve = dns.lookup, signal) => {
  const url = new URL(input);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
    throw new Error("Remote attachment URL must be HTTP/HTTPS without credentials.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = net.isIP(hostname)
    ? [{ address: hostname, family: net.isIP(hostname) }]
    : await withinDeadline(resolve(hostname, { all: true, verbatim: true }), signal);
  if (!addresses.length || addresses.some(({ address }) => !safeAddress(address))) {
    throw new Error("Remote attachment URL resolves to a private or reserved address.");
  }
  return { url, address: addresses[0] };
};

export const downloadRemoteAttachment = async (input, { maxBytes, timeoutMs, resolve = dns.lookup, requestUrl } = {}) => {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new Error("Remote attachment size and timeout limits must be positive integers.");
  }
  const deadline = AbortSignal.timeout(timeoutMs);
  let current = input;
  for (let redirects = 0; redirects <= 5; redirects++) {
    const { url, address } = await validateRemoteUrl(current, resolve, deadline);
    const response = await new Promise((resolveResponse, reject) => {
      const request = (requestUrl || ((target, options, callback) =>
        (target.protocol === "https:" ? https : http).get(target, options, callback)))(url, {
        signal: deadline,
        lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
        agent: false
      }, resolveResponse);
      request.on("error", reject);
    });

    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (!response.headers.location || redirects === 5) {
        throw new Error("Remote attachment redirect limit exceeded.");
      }
      current = new URL(response.headers.location, url).href;
      continue;
    }
    if (response.statusCode < 200 || response.statusCode >= 300) {
      response.destroy();
      throw new Error(`Could not fetch attachment URL: HTTP ${response.statusCode}`);
    }
    const declared = Number(response.headers["content-length"]);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      throw new Error(`Remote attachment exceeds the ${maxBytes} byte limit.`);
    }
    const chunks = [];
    let size = 0;
    try {
      for await (const chunk of response) {
        size += chunk.length;
        if (size > maxBytes) {
          response.destroy();
          throw new Error(`Remote attachment exceeds the ${maxBytes} byte limit.`);
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (size > maxBytes) throw new Error(`Remote attachment exceeds the ${maxBytes} byte limit.`);
      throw error;
    }
    return { buffer: Buffer.concat(chunks, size), headers: response.headers, url: url.href };
  }
};

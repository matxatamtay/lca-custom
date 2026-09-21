import dns from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";

export function createNetworkDoctorProbes(options) {
  const { redact, timed } = options;

  async function dnsTest(host) {
    return timed(`dns:${host}`, async () => {
      const records = await dns.lookup(host, { all: true });
      return { addresses: records.map((r) => `${r.address}/${r.family}`).slice(0, 12) };
    });
  }

  async function tcpTest(host, port = 443) {
    return timed(`tcp:${host}:${port}`, () => new Promise((resolveTest, rejectTest) => {
      const socket = net.createConnection({ host, port, timeout: 5000 });
      socket.once("connect", () => {
        socket.destroy();
        resolveTest({ remote: `${host}:${port}` });
      });
      socket.once("timeout", () => {
        socket.destroy();
        rejectTest(new Error("TCP timeout"));
      });
      socket.once("error", rejectTest);
    }));
  }

  async function tlsTest(host, port = 443) {
    return timed(`tls:${host}:${port}`, () => new Promise((resolveTest, rejectTest) => {
      const socket = tls.connect({
        host,
        port,
        servername: host,
        ALPNProtocols: ["h2", "http/1.1"],
        timeout: 7000
      });
      socket.once("secureConnect", () => {
        const cert = socket.getPeerCertificate();
        const protocol = socket.alpnProtocol || "none";
        socket.destroy();
        resolveTest({
          authorized: socket.authorized,
          authorizationError: socket.authorizationError || "",
          alpn: protocol,
          certificate: {
            subject: cert?.subject?.CN || "",
            issuer: cert?.issuer?.CN || cert?.issuer?.O || "",
            valid_to: cert?.valid_to || ""
          }
        });
      });
      socket.once("timeout", () => {
        socket.destroy();
        rejectTest(new Error("TLS timeout"));
      });
      socket.once("error", rejectTest);
    }));
  }

  async function requestTest(url, { method = "GET", headers = {}, timeout = 8000 } = {}) {
    return timed(`http:${method}:${url}`, () => new Promise((resolveTest, rejectTest) => {
      const u = new URL(url);
      const mod = u.protocol === "https:" ? https : http;
      const req = mod.request(u, { method, headers, timeout }, (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          if (body.length < 2000) body += chunk;
        });
        res.on("end", () => {
          resolveTest({
            status: res.statusCode,
            statusMessage: res.statusMessage,
            headers: pickHeaders(res.headers),
            body_sample: redact(body.slice(0, 500))
          });
        });
      });
      req.once("timeout", () => {
        req.destroy(new Error("HTTP timeout"));
      });
      req.once("error", rejectTest);
      req.end();
    }));
  }

  function pickHeaders(headers) {
    const names = ["content-type", "server", "date", "cf-ray", "openai-processing-ms", "x-request-id"];
    const out = {};
    for (const name of names) {
      if (headers[name]) out[name] = headers[name];
    }
    return out;
  }


  return { dnsTest, requestTest, tcpTest, tlsTest };
}

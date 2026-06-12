import { execFile } from "node:child_process";
import { createConnection } from "node:net";
import { promisify } from "node:util";
import dns from "node:dns/promises";

const execFileAsync = promisify(execFile);
const host = "api.openai.com";
const commonProxyPorts = [7890, 7891, 1080, 6152, 20170, 15235, 15236, 18789, 18791];
let detectedSystemProxyEnv;

function redactProxy(value) {
  if (!value) {
    return "(not set)";
  }
  return value.replace(/:\/\/[^/@]+@/g, "://[credentials]@");
}

function checkPort(port) {
  return new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port, timeout: 800 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function showSystemProxy() {
  try {
    const { stdout } = await execFileAsync("scutil", ["--proxy"], { encoding: "utf8", maxBuffer: 256 * 1024 });
    const trimmed = stdout.trim();
    console.log("macOS system proxy:");
    console.log(trimmed ? trimmed.replace(/^/gm, "  ") : "  (empty)");
    detectedSystemProxyEnv = proxyEnvFromScutil(stdout);
  } catch (error) {
    console.log(`macOS system proxy check failed: ${error.code || error.message}`);
  }
}

function valueFromScutil(stdout, key) {
  const pattern = new RegExp(`${key}\\s*:\\s*([^\\n]+)`);
  return pattern.exec(stdout)?.[1]?.trim();
}

function proxyEnvFromScutil(stdout) {
  const httpsEnabled = valueFromScutil(stdout, "HTTPSEnable") === "1";
  const httpEnabled = valueFromScutil(stdout, "HTTPEnable") === "1";
  const socksEnabled = valueFromScutil(stdout, "SOCKSEnable") === "1";
  const env = {};

  if (httpsEnabled) {
    const proxy = valueFromScutil(stdout, "HTTPSProxy");
    const portValue = valueFromScutil(stdout, "HTTPSPort");
    if (proxy && portValue) {
      env.HTTPS_PROXY = `http://${proxy}:${portValue}`;
    }
  }

  if (httpEnabled) {
    const proxy = valueFromScutil(stdout, "HTTPProxy");
    const portValue = valueFromScutil(stdout, "HTTPPort");
    if (proxy && portValue) {
      env.HTTP_PROXY = `http://${proxy}:${portValue}`;
    }
  }

  if (!env.HTTPS_PROXY && !env.HTTP_PROXY && socksEnabled) {
    const proxy = valueFromScutil(stdout, "SOCKSProxy");
    const portValue = valueFromScutil(stdout, "SOCKSPort");
    if (proxy && portValue) {
      env.ALL_PROXY = `socks5h://${proxy}:${portValue}`;
    }
  }

  return Object.keys(env).length ? env : undefined;
}

function explicitProxyEnv() {
  const env = {};
  if (process.env.HTTPS_PROXY || process.env.https_proxy) {
    env.HTTPS_PROXY = process.env.HTTPS_PROXY || process.env.https_proxy;
  }
  if (process.env.HTTP_PROXY || process.env.http_proxy) {
    env.HTTP_PROXY = process.env.HTTP_PROXY || process.env.http_proxy;
  }
  if (process.env.ALL_PROXY || process.env.all_proxy) {
    env.ALL_PROXY = process.env.ALL_PROXY || process.env.all_proxy;
  }
  return Object.keys(env).length ? env : undefined;
}

function proxyLabel(env) {
  if (!env) {
    return "direct";
  }
  return env.HTTPS_PROXY || env.HTTP_PROXY || env.ALL_PROXY || "configured";
}

async function showListeningPorts() {
  try {
    const { stdout } = await execFileAsync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024
    });
    const lines = stdout
      .split(/\r?\n/)
      .filter((line) => /(127\.0\.0\.1|\[::1\]|localhost)/.test(line))
      .slice(0, 30);

    console.log("Localhost listening TCP ports:");
    if (lines.length) {
      for (const line of lines) {
        console.log(`  ${line}`);
      }
    } else {
      console.log("  (none shown)");
    }
  } catch (error) {
    console.log(`Listening port check failed: ${error.code || error.message}`);
  }
}

async function checkDns() {
  try {
    const addresses = await dns.lookup(host, { all: true });
    console.log(`DNS ${host}:`);
    for (const address of addresses) {
      console.log(`  - ${address.address}`);
    }

    if (addresses.some((address) => address.address.startsWith("31.13.") || address.address.startsWith("2a03:2880:"))) {
      console.log("  ! These addresses look suspicious for OpenAI. DNS may be polluted or routed outside the VPN.");
    }
  } catch (error) {
    console.log(`DNS lookup failed: ${error.code || error.message}`);
  }
}

async function checkCurl() {
  const proxyEnv = explicitProxyEnv() || detectedSystemProxyEnv;
  console.log(`curl route: ${proxyLabel(proxyEnv)}`);

  try {
    const { stdout, stderr } = await execFileAsync(
      "curl",
      ["-sS", "--connect-timeout", "10", "--max-time", "20", "-o", "/dev/null", "-w", "%{http_code}", `https://${host}/v1/models`],
      {
        encoding: "utf8",
        env: proxyEnv ? { ...process.env, ...proxyEnv } : process.env,
        maxBuffer: 256 * 1024
      }
    );
    const status = stdout.trim();
    console.log(`curl reachability: HTTP ${status || "(no status)"}`);
    if (status === "401") {
      console.log("  OK: OpenAI API is reachable from Terminal. 401 is expected without an Authorization header.");
    } else if (status === "000") {
      console.log(`  curl stderr: ${stderr.trim() || "(empty)"}`);
    }
  } catch (error) {
    console.log(`curl reachability failed: ${error.code || error.message}`);
    if (error.stderr) {
      console.log(`  ${error.stderr.trim()}`);
    }
  }
}

async function main() {
  console.log("Thought Companion network doctor\n");
  console.log("Proxy environment:");
  console.log(`  HTTPS_PROXY=${redactProxy(process.env.HTTPS_PROXY || process.env.https_proxy)}`);
  console.log(`  HTTP_PROXY=${redactProxy(process.env.HTTP_PROXY || process.env.http_proxy)}`);
  console.log(`  ALL_PROXY=${redactProxy(process.env.ALL_PROXY || process.env.all_proxy)}`);
  console.log("");

  await showSystemProxy();
  console.log("");

  console.log("Local proxy ports:");
  for (const port of commonProxyPorts) {
    const open = await checkPort(port);
    console.log(`  127.0.0.1:${port} ${open ? "open" : "closed"}`);
  }
  console.log("");

  await showListeningPorts();
  console.log("");

  await checkDns();
  console.log("");
  await checkCurl();

  console.log("\nIf curl times out, start this app with proxy env vars, for example:");
  console.log('  export HTTPS_PROXY="http://127.0.0.1:15236"');
  console.log('  export HTTP_PROXY="http://127.0.0.1:15236"');
  console.log('  export ALL_PROXY="http://127.0.0.1:15236"');
  console.log("  npm start");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

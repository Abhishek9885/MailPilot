const renderApi = "https://api.render.com/v1";
const deployTimeoutMs = 45 * 60 * 1000;
const pollIntervalMs = 15 * 1000;
const healthTimeoutMs = 10 * 60 * 1000;
const terminalFailureStatuses = new Set([
  "build_failed",
  "pre_deploy_failed",
  "update_failed",
  "canceled",
  "deactivated"
]);
const inProgressStatuses = new Set([
  "created",
  "queued",
  "build_in_progress",
  "pre_deploy_in_progress",
  "update_in_progress"
]);

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Missing required deployment setting: ${name}`);
  return value;
}

const token = required("RENDER_API_TOKEN");
const commitId = required("DEPLOY_COMMIT");
const services = [
  ["API", required("RENDER_API_SERVICE_ID")],
  ["AI", required("RENDER_AI_SERVICE_ID")],
  ["worker", required("RENDER_WORKER_SERVICE_ID")],
  ["web", required("RENDER_WEB_SERVICE_ID")]
];

async function request(path, init) {
  let response;
  try {
    response = await fetch(`${renderApi}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init?.headers
      }
    });
  } catch {
    throw new Error("Could not reach the Render deployment API.");
  }

  if (!response.ok) throw new Error(`Render deployment API returned HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error("Render returned an invalid deployment response.");
  }
}

async function deployAndWait(name, serviceId) {
  console.log(`Starting ${name} deploy for commit ${commitId.slice(0, 12)}.`);
  const created = await request(`/services/${encodeURIComponent(serviceId)}/deploys`, {
    method: "POST",
    body: JSON.stringify({ commitId })
  });
  const deployId = created.id ?? created.deploy?.id;
  if (typeof deployId !== "string" || deployId.length === 0) {
    throw new Error(`Render did not return a deployment ID for ${name}.`);
  }

  const deadline = Date.now() + deployTimeoutMs;
  while (Date.now() < deadline) {
    const deploy = await request(
      `/services/${encodeURIComponent(serviceId)}/deploys/${encodeURIComponent(deployId)}`,
      { method: "GET" }
    );
    const status = deploy.status;
    console.log(`${name} deployment status: ${String(status)}.`);
    if (status === "live") return;
    if (terminalFailureStatuses.has(status)) {
      throw new Error(`${name} deployment ended with status ${String(status)}.`);
    }
    if (!inProgressStatuses.has(status)) {
      throw new Error(`${name} deployment returned an unexpected status.`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`${name} deployment did not finish within 45 minutes.`);
}

async function waitForHealth(name, url) {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { headers: { Accept: "application/json" } });
      if (response.ok) {
        const body = await response.json();
        if (body.status === "ok") {
          console.log(`${name} readiness check passed.`);
          return;
        }
      }
    } catch {
      // Continue bounded polling while the newly deployed services start.
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`${name} readiness check did not pass within 10 minutes.`);
}

for (const [name, serviceId] of services) {
  await deployAndWait(name, serviceId);
}

await waitForHealth("web", "https://mailpilot-web.onrender.com/api/health");
await waitForHealth("API", "https://mailpilot-web.onrender.com/health/ready");
await waitForHealth("AI", "https://mailpilot-ai.onrender.com/health/ready");

console.log("All production services deployed successfully.");

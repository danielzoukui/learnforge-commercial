/**
 * Northflank deployment automation.
 *
 * Turns the twelve-step UI walkthrough into idempotent API calls:
 *
 *   project → PostgreSQL addon → secret group (addon linked as DATABASE_URL)
 *           → combined service (Dockerfile, port 8080, health check) → build
 *
 * Endpoint paths and payload shapes follow the published Northflank API
 * reference (northflank.com/docs/v1/api). Every step is "ensure"-style: it looks
 * for the resource by name first, so re-running after a partial failure is safe.
 *
 * NOTE ON VERIFICATION: api.northflank.com is not reachable from the environment
 * where this file was written, so these calls were validated against the API
 * documentation plus a local mock of the API (tests/test-golive-pipeline.mjs),
 * not against a live account. `--dry-run` prints every request before it is sent.
 */

import { HttpClient, pickArray, pickId, poll } from "./providers.mjs";

export const DEFAULT_REGION = "europe-west";
export const DEFAULT_PLANS = {
  addon: "nf-compute-20",
  service: "nf-compute-20",
  build: "nf-compute-20"
};

export const REPO_URL = "https://github.com/danielzoukui/learnforge-commercial";
export const SERVICE_PORT = 8080;

export class NorthflankClient {
  constructor({ token, baseUrl = "https://api.northflank.com/v1", dryRun = false, log }) {
    this.http = new HttpClient({ provider: "northflank", baseUrl, token, dryRun, log });
    this.log = log;
    this.dryRun = dryRun;
  }

  // --- projects -------------------------------------------------------------
  async listProjects() {
    return pickArray((await this.http.get("/projects")).data, ["projects"]);
  }

  async ensureProject({ name, description = "LearnForge Commercial", region = DEFAULT_REGION }) {
    const existing = (await this.listProjects()).find((project) => project.name === name);
    if (existing) {
      this.log?.ok(`project "${name}" already exists (${existing.id})`);
      return existing.id;
    }
    const created = await this.http.post("/projects", { body: { name, description, region, color: "#6366f1" } });
    const id = pickId(created.data) || name;
    this.log?.ok(`created project "${name}" (${id})`);
    return id;
  }

  /**
   * Read-only lookup of existing resources, for phases that run on their own
   * (e.g. `--phase=stripe` after the infrastructure already exists). Never
   * creates anything.
   */
  async resolveContext({ projectName, secretName }) {
    const project = (await this.listProjects()).find((entry) => entry.name === projectName);
    if (!project) {
      this.log?.warn(`project "${projectName}" not found — run the infra phase first (or pass --project <name>)`);
      return { projectId: null, secretId: null };
    }
    const secret = (await this.listSecrets(project.id)).find((entry) => entry.name === secretName);
    if (!secret) this.log?.warn(`secret group "${secretName}" not found in project "${projectName}"`);
    return { projectId: project.id, secretId: secret?.id || null };
  }

  // --- addons ---------------------------------------------------------------
  async listAddons(projectId) {
    return pickArray((await this.http.get(`/projects/${projectId}/addons`)).data, ["addons"]);
  }

  async ensurePostgresAddon({ projectId, name = "learnforge-postgres", plan = DEFAULT_PLANS.addon, storageMb = 4096, database = "learnforge" }) {
    const existing = (await this.listAddons(projectId)).find((addon) => addon.name === name);
    if (existing) {
      this.log?.ok(`PostgreSQL addon "${name}" already exists (${existing.id})`);
      return existing.id;
    }
    const created = await this.http.post(`/projects/${projectId}/addons`, {
      body: {
        name,
        description: "LearnForge commercial PostgreSQL",
        type: "postgresql",
        version: "16",
        billing: { deploymentPlan: plan, storageClass: "ssd", storage: storageMb, replicas: 1 },
        tlsEnabled: true,
        // Production default: reachable only from inside the project. Enable
        // external access temporarily if you prefer to migrate from your laptop.
        externalAccessEnabled: false,
        ipPolicies: [],
        pitrEnabled: false,
        typeSpecificSettings: { postgresDatabase: database }
      },
      synthetic: { name }
    });
    const id = pickId(created.data) || name;
    this.log?.ok(`created PostgreSQL 16 addon "${name}" (${id})`);
    return id;
  }

  async waitForAddon({ projectId, addonId, attempts = 60, intervalMs = 10_000 }) {
    return poll({
      log: this.log,
      label: `addon ${addonId}`,
      attempts,
      intervalMs,
      check: async () => {
        const { data } = await this.http.get(`/projects/${projectId}/addons/${addonId}`);
        const status = data?.data?.status || data?.status || "unknown";
        return { done: ["ready", "running"].includes(status), detail: `status=${status}`, value: status };
      }
    });
  }

  // --- secrets --------------------------------------------------------------
  async listSecrets(projectId) {
    return pickArray((await this.http.get(`/projects/${projectId}/secrets`)).data, ["secrets"]);
  }

  /**
   * Creates the secret group with the addon's POSTGRES_URI linked as DATABASE_URL.
   * `restricted: false` means every workload in the project receives these
   * variables, which is what lets the service pick up the connection string
   * without a second linking call.
   */
  async ensureSecretGroup({ projectId, addonId, name = "learnforge-secrets", variables = {} }) {
    const existing = (await this.listSecrets(projectId)).find((secret) => secret.name === name);
    if (existing) {
      this.log?.ok(`secret group "${name}" already exists (${existing.id})`);
      const updated = await this.syncSecretVariables({ projectId, secretId: existing.id, variables });
      return { id: existing.id, updated };
    }

    const created = await this.http.post(`/projects/${projectId}/secrets`, {
      body: {
        name,
        description: "LearnForge commercial runtime configuration",
        type: "secret",
        secretType: "environment",
        priority: 10,
        restrictions: { restricted: false, nfObjects: [], tagMatchCondition: "or" },
        addonDependencies: [
          { addonId, keys: [{ keyName: "POSTGRES_URI", aliases: ["DATABASE_URL"] }] }
        ],
        secrets: { variables, files: {}, dockerSecretMounts: {} }
      },
      synthetic: { name }
    });
    const id = pickId(created.data) || name;
    this.log?.ok(`created secret group "${name}" with DATABASE_URL linked from the addon`);
    return { id, updated: Object.keys(variables).length };
  }

  /** Adds or updates the given variables on an existing secret group. */
  async syncSecretVariables({ projectId, secretId, variables }) {
    const names = Object.keys(variables);
    if (!names.length) return 0;
    try {
      await this.http.patch(`/projects/${projectId}/secrets/${secretId}`, {
        body: { secrets: { variables, files: {}, dockerSecretMounts: {} } }
      });
      this.log?.ok(`updated ${names.length} secret variable(s): ${names.join(", ")}`);
      return names.length;
    } catch (error) {
      // A different API version may not expose PATCH here. Do not fail the whole
      // deployment over it: tell the operator exactly what to paste instead.
      this.log?.warn(`could not update the secret group via the API (${error?.status || ""} ${error?.message || error})`);
      this.log?.warn("set these variables on the secret group in the Northflank UI, then restart the service:");
      for (const [key, value] of Object.entries(variables)) this.log?.warn(`    ${key}=${value}`);
      return 0;
    }
  }

  // --- services -------------------------------------------------------------
  async listServices(projectId) {
    return pickArray((await this.http.get(`/projects/${projectId}/services`)).data, ["services"]);
  }

  async getService({ projectId, serviceId }) {
    const { data } = await this.http.get(`/projects/${projectId}/services/${serviceId}`);
    return data?.data || data;
  }

  async ensureCombinedService({
    projectId,
    name = "learnforge",
    plan = DEFAULT_PLANS.service,
    buildPlan = DEFAULT_PLANS.build,
    repoUrl = REPO_URL,
    branch = "main",
    healthCheckPath = "/_runtime/health",
    instances = 1
  }) {
    const existing = (await this.listServices(projectId)).find((service) => service.name === name);
    if (existing) {
      this.log?.ok(`service "${name}" already exists (${existing.id})`);
      return existing.id;
    }

    const created = await this.http.post(`/projects/${projectId}/services/combined`, {
      body: {
        name,
        description: "LearnForge Commercial — static product pages + 15 commercial API routes",
        billing: { deploymentPlan: plan, buildPlan },
        deployment: {
          instances,
          docker: { configType: "default" },
          storage: { ephemeralStorage: { storageSize: 1024 }, shmSize: 64 }
        },
        ports: [
          {
            name: "http",
            internalPort: SERVICE_PORT,
            protocol: "HTTP",
            public: true,
            domains: [],
            security: { policies: [], credentials: [] },
            disableNfDomain: false
          }
        ],
        healthChecks: [
          {
            protocol: "HTTP",
            type: "livenessProbe",
            path: healthCheckPath,
            port: SERVICE_PORT,
            initialDelaySeconds: 20,
            periodSeconds: 30,
            timeoutSeconds: 5,
            failureThreshold: 3,
            successThreshold: 1
          }
        ],
        vcsData: { projectUrl: repoUrl, projectType: "github", projectBranch: branch },
        buildSource: "git",
        buildSettings: {
          dockerfile: {
            buildEngine: "buildkit",
            dockerFilePath: "/Dockerfile",
            dockerWorkDir: "/",
            buildkit: { useCache: true }
          }
        },
        buildConfiguration: {
          pathIgnoreRules: ["*.zip", "*.md"],
          isAllowList: false,
          ciIgnoreFlagsEnabled: false,
          ignoreEmptyCommits: false
        },
        runtimeEnvironment: {},
        runtimeFiles: {},
        buildArguments: {},
        buildFiles: {},
        disabledCI: false
      },
      synthetic: { name }
    });

    const id = pickId(created.data) || name;
    this.log?.ok(`created combined service "${name}" (${id}) on port ${SERVICE_PORT}, health check ${healthCheckPath}`);
    return id;
  }

  async startBuild({ projectId, serviceId, branch }) {
    const { data } = await this.http.post(`/projects/${projectId}/services/${serviceId}/build`, {
      body: branch ? { branch } : {}
    });
    const buildId = pickId(data, ["id", "buildId"]);
    this.log?.ok(`triggered build${buildId ? ` ${buildId}` : ""} for service ${serviceId}`);
    return buildId;
  }

  /**
   * Restarts the service so newly written secret variables take effect. Falls
   * back to an actionable message if the API version does not expose restart.
   */
  async restartService({ projectId, serviceId }) {
    try {
      await this.http.post(`/projects/${projectId}/services/${serviceId}/restart`, { expect: [200, 201, 202, 204] });
      this.log?.ok(`restarted service ${serviceId} to pick up the new secrets`);
      return true;
    } catch (error) {
      this.log?.warn(`could not restart the service via the API (${error?.status || ""} ${error?.message || error})`);
      this.log?.warn("restart the service from the Northflank UI so new secrets take effect");
      return false;
    }
  }

  /** Polls the service until it reports a running deployment with a public DNS name. */
  async waitForService({ projectId, serviceId, attempts = 60, intervalMs = 10_000 }) {
    return poll({
      log: this.log,
      label: `service ${serviceId}`,
      attempts,
      intervalMs,
      check: async () => {
        const service = await this.getService({ projectId, serviceId });
        const ports = service?.ports || [];
        const dns = ports[0]?.dns || null;
        const status = service?.status || service?.deployment?.status || "unknown";
        const ready = Boolean(dns) && ["running", "ready", "completed", "deployed"].some((value) => String(status).toLowerCase().includes(value));
        return { done: ready, detail: `status=${status} dns=${dns || "pending"}`, value: { status, dns } };
      }
    });
  }
}

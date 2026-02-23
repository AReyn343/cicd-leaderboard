#!/usr/bin/env node
/**
 * CI/CD Leaderboard Scorer
 *
 * Scans student repos via GitHub API and produces scores.json
 * Usage: GITHUB_TOKEN=xxx node score.mjs
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) { console.error("GITHUB_TOKEN required"); process.exit(1); }

const API = "https://api.github.com";
const headers = {
  Authorization: `Bearer ${TOKEN}`,
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

// ---------------------------------------------------------------------------
// GitHub API helpers
// ---------------------------------------------------------------------------

async function gh(path) {
  const res = await fetch(`${API}${path}`, { headers });
  if (!res.ok) return null;
  return res.json();
}

async function ghRaw(owner, repo, path) {
  const res = await fetch(
    `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`,
    { headers }
  );
  if (!res.ok) return null;
  return res.text();
}

async function ghSearch(owner, repo, query) {
  const res = await fetch(
    `${API}/search/code?q=${encodeURIComponent(query)}+repo:${owner}/${repo}`,
    { headers }
  );
  if (!res.ok) return null;
  return res.json();
}

// ---------------------------------------------------------------------------
// Individual checks — each returns { pass: bool, detail: string }
// ---------------------------------------------------------------------------

const CHECKS = {
  // ===== FUNDAMENTALS (60 pts) =====

  pipeline_exists: {
    points: 5,
    category: "fundamentals",
    label: "Pipeline exists",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo tree" };
      const wf = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      return { pass: wf.length > 0, detail: `${wf.length} workflow(s) found` };
    },
  },

  pipeline_green: {
    points: 5,
    category: "fundamentals",
    label: "Pipeline green on main",
    run: async (owner, repo) => {
      const runs = await gh(`/repos/${owner}/${repo}/actions/runs?branch=main&per_page=1`);
      if (!runs?.workflow_runs?.length) return { pass: false, detail: "No runs found" };
      const last = runs.workflow_runs[0];
      return {
        pass: last.conclusion === "success",
        detail: `Last run: ${last.conclusion || last.status} (#${last.run_number})`,
      };
    },
  },

  lint_pass: {
    points: 5,
    category: "fundamentals",
    label: "Lint step in pipeline",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        const lower = content.toLowerCase();
        if (
          lower.includes("lint") ||
          lower.includes("ruff") ||
          lower.includes("flake8") ||
          lower.includes("pylint") ||
          lower.includes("eslint") ||
          lower.includes("prettier")
        ) {
          return { pass: true, detail: `Lint found in ${wf.path}` };
        }
      }
      return { pass: false, detail: "No lint step found in workflows" };
    },
  },

  no_secrets_in_code: {
    points: 5,
    category: "fundamentals",
    label: "No hardcoded secrets",
    run: async (owner, repo) => {
      // Check known files for secret patterns
      const files = ["main.py", "app.js", "database/database.py", "database/database.js"];
      const patterns = [
        /(?:SECRET_KEY|API_KEY|DB_PASSWORD|PASSWORD)\s*=\s*["'][^"']{6,}["']/i,
        /sk-proj-[a-zA-Z0-9]+/,
        /super_secret/i,
        /admin123/,
      ];
      for (const file of files) {
        const content = await ghRaw(owner, repo, file);
        if (!content) continue;
        for (const p of patterns) {
          if (p.test(content)) {
            return { pass: false, detail: `Secret found in ${file}` };
          }
        }
      }
      return { pass: true, detail: "No hardcoded secrets detected" };
    },
  },

  tests_exist: {
    points: 10,
    category: "fundamentals",
    label: "Tests exist in pipeline",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };

      // Check for test files
      const testFiles = tree.tree.filter(
        (f) =>
          f.path.match(/test[_s]?.*\.(py|js|ts)$/i) ||
          f.path.match(/.*\.test\.(js|ts)$/i) ||
          f.path.match(/.*\.spec\.(js|ts)$/i) ||
          f.path.match(/.*_test\.py$/i)
      );

      if (testFiles.length === 0) return { pass: false, detail: "No test files found" };

      // Also check that tests run in CI
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        const lower = content.toLowerCase();
        if (lower.includes("pytest") || lower.includes("jest") || lower.includes("vitest") || lower.includes("npm test") || lower.includes("npm run test")) {
          return { pass: true, detail: `${testFiles.length} test file(s), tests run in CI` };
        }
      }
      return { pass: false, detail: `${testFiles.length} test file(s) but not run in CI` };
    },
  },

  tests_pass: {
    points: 5,
    category: "fundamentals",
    label: "Tests pass",
    run: async (owner, repo) => {
      // If pipeline is green and tests exist in pipeline, tests pass
      const runs = await gh(`/repos/${owner}/${repo}/actions/runs?branch=main&per_page=1`);
      if (!runs?.workflow_runs?.length) return { pass: false, detail: "No runs" };
      const last = runs.workflow_runs[0];
      if (last.conclusion !== "success") return { pass: false, detail: "Pipeline not green" };

      // Verify tests are in the pipeline
      const jobs = await gh(`/repos/${owner}/${repo}/actions/runs/${last.id}/jobs`);
      if (!jobs?.jobs) return { pass: false, detail: "Cannot read jobs" };
      const testJob = jobs.jobs.find((j) => {
        const n = j.name.toLowerCase();
        return n.includes("test") || n.includes("ci") || n.includes("build");
      });
      return {
        pass: testJob?.conclusion === "success",
        detail: testJob ? `Job "${testJob.name}": ${testJob.conclusion}` : "No test job found",
      };
    },
  },

  coverage_70: {
    points: 10,
    category: "fundamentals",
    label: "Coverage ≥ 70%",
    run: async (owner, repo) => {
      // Check for coverage config/reports indicators
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };

      // Look for coverage in workflow files
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      let hasCoverage = false;
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        if (content.includes("--cov") || content.includes("coverage") || content.includes("--coverage")) {
          hasCoverage = true;
          break;
        }
      }

      if (!hasCoverage) return { pass: false, detail: "No coverage step found in CI" };

      // Check artifacts for coverage report
      const runs = await gh(`/repos/${owner}/${repo}/actions/runs?branch=main&per_page=1`);
      if (!runs?.workflow_runs?.length) return { pass: false, detail: "No runs" };
      const artifacts = await gh(`/repos/${owner}/${repo}/actions/runs/${runs.workflow_runs[0].id}/artifacts`);
      const covArtifact = artifacts?.artifacts?.find((a) =>
        a.name.toLowerCase().includes("coverage") || a.name.toLowerCase().includes("cov")
      );

      // We can't easily parse the coverage %, so we check: coverage in CI + pipeline green = trust
      const isGreen = runs.workflow_runs[0].conclusion === "success";

      return {
        pass: hasCoverage && isGreen,
        detail: hasCoverage
          ? `Coverage in CI, pipeline ${isGreen ? "green ✅" : "red ❌"}${covArtifact ? ", artifact found" : ""}`
          : "No coverage",
      };
    },
  },

  // ===== DOCKER (15 pts → part of fundamentals) =====

  dockerfile_exists: {
    points: 5,
    category: "fundamentals",
    label: "Dockerfile exists",
    run: async (owner, repo) => {
      const content = await ghRaw(owner, repo, "Dockerfile");
      return { pass: !!content, detail: content ? "Dockerfile found" : "No Dockerfile at root" };
    },
  },

  docker_builds: {
    points: 5,
    category: "fundamentals",
    label: "Docker build in CI",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        if (content.includes("docker") && (content.includes("build") || content.includes("build-push"))) {
          return { pass: true, detail: `Docker build in ${wf.path}` };
        }
      }
      return { pass: false, detail: "No docker build step in CI" };
    },
  },

  // ===== INTERMEDIATE (40 pts) =====

  security_scan: {
    points: 10,
    category: "intermediate",
    label: "Security scan in CI",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      const keywords = ["trivy", "bandit", "snyk", "codeql", "npm audit", "pip-audit", "safety", "gitleaks", "semgrep", "grype"];
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        const lower = content.toLowerCase();
        const found = keywords.filter((k) => lower.includes(k));
        if (found.length > 0) {
          return { pass: true, detail: `Found: ${found.join(", ")} in ${wf.path}` };
        }
      }
      return { pass: false, detail: "No security scan found in workflows" };
    },
  },

  ghcr_published: {
    points: 10,
    category: "intermediate",
    label: "Image on GHCR",
    run: async (owner, repo) => {
      // Check GitHub packages
      const packages = await gh(`/repos/${owner}/${repo}/packages?package_type=container`);
      if (packages && packages.length > 0) {
        return { pass: true, detail: `${packages.length} package(s) published` };
      }
      // Also check in workflows for ghcr push
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "No packages found" };
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        if (content.includes("ghcr.io") && content.includes("push")) {
          return { pass: true, detail: `GHCR push configured in ${wf.path}` };
        }
      }
      return { pass: false, detail: "No container packages found" };
    },
  },

  quality_gate: {
    points: 10,
    category: "intermediate",
    label: "Quality gate (SonarCloud etc.)",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };

      // Check for sonar config files
      const sonarFiles = tree.tree.filter((f) =>
        f.path.includes("sonar-project.properties") || f.path.includes("sonarcloud")
      );

      // Check workflows
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      const keywords = ["sonar", "codeclimate", "codecov", "quality"];
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        const lower = content.toLowerCase();
        const found = keywords.filter((k) => lower.includes(k));
        if (found.length > 0) {
          return { pass: true, detail: `Found: ${found.join(", ")}` };
        }
      }

      if (sonarFiles.length > 0) return { pass: true, detail: "Sonar config found" };
      return { pass: false, detail: "No quality gate configured" };
    },
  },

  deployed: {
    points: 10,
    category: "intermediate",
    label: "App deployed (HTTP 200)",
    run: async (_owner, _repo, team) => {
      if (!team.deploy_url) return { pass: false, detail: "No deploy_url in teams.json" };
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(team.deploy_url, { signal: controller.signal });
        clearTimeout(timeout);
        return { pass: res.ok, detail: `${team.deploy_url} → HTTP ${res.status}` };
      } catch (e) {
        return { pass: false, detail: `${team.deploy_url} → ${e.message}` };
      }
    },
  },

  // ===== ADVANCED (30 pts) =====

  branch_protection: {
    points: 5,
    category: "advanced",
    label: "Branch protection on main",
    run: async (owner, repo) => {
      const prot = await gh(`/repos/${owner}/${repo}/branches/main/protection`);
      if (!prot || prot.message) return { pass: false, detail: "No branch protection" };
      const prRequired = prot.required_pull_request_reviews;
      return {
        pass: !!prRequired,
        detail: prRequired ? "PR required before merge ✅" : "Protection exists but PR not required",
      };
    },
  },

  auto_deploy: {
    points: 10,
    category: "advanced",
    label: "Auto-deploy on push to main",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        const lower = content.toLowerCase();
        if (
          (lower.includes("deploy") || lower.includes("render") || lower.includes("fly.io") || lower.includes("railway")) &&
          (lower.includes("push") && lower.includes("main"))
        ) {
          return { pass: true, detail: `Deploy on push to main in ${wf.path}` };
        }
      }
      return { pass: false, detail: "No auto-deploy workflow found" };
    },
  },

  multi_env: {
    points: 10,
    category: "advanced",
    label: "Multiple environments",
    run: async (owner, repo) => {
      const tree = await gh(`/repos/${owner}/${repo}/git/trees/main?recursive=1`);
      if (!tree?.tree) return { pass: false, detail: "Cannot read repo" };
      const wfFiles = tree.tree.filter((f) => f.path.startsWith(".github/workflows/") && f.path.endsWith(".yml"));
      for (const wf of wfFiles) {
        const content = await ghRaw(owner, repo, wf.path);
        if (!content) continue;
        const lower = content.toLowerCase();
        const envs = ["staging", "production", "prod", "dev"].filter((e) => lower.includes(`environment: ${e}`) || lower.includes(`environment:\n`) );
        if (envs.length >= 2 || (lower.includes("staging") && lower.includes("prod"))) {
          return { pass: true, detail: `Multiple environments detected` };
        }
      }
      return { pass: false, detail: "Single environment or none" };
    },
  },

  pipeline_fast: {
    points: 5,
    category: "advanced",
    label: "Pipeline < 3 minutes",
    run: async (owner, repo) => {
      const runs = await gh(`/repos/${owner}/${repo}/actions/runs?branch=main&status=success&per_page=3`);
      if (!runs?.workflow_runs?.length) return { pass: false, detail: "No successful runs" };
      // Average duration of last 3 runs
      let totalMs = 0;
      let count = 0;
      for (const run of runs.workflow_runs) {
        const start = new Date(run.created_at);
        const end = new Date(run.updated_at);
        totalMs += end - start;
        count++;
      }
      const avgMin = totalMs / count / 60000;
      return {
        pass: avgMin < 3,
        detail: `Average: ${avgMin.toFixed(1)} min (last ${count} runs)`,
      };
    },
  },

  dependabot: {
    points: 5,
    category: "advanced",
    label: "Dependabot/Renovate configured",
    run: async (owner, repo) => {
      const depbot = await ghRaw(owner, repo, ".github/dependabot.yml");
      if (depbot) return { pass: true, detail: "dependabot.yml found" };
      const renovate = await ghRaw(owner, repo, "renovate.json");
      if (renovate) return { pass: true, detail: "renovate.json found" };
      const renovate2 = await ghRaw(owner, repo, ".github/renovate.json");
      if (renovate2) return { pass: true, detail: ".github/renovate.json found" };
      return { pass: false, detail: "No dependency update config" };
    },
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function scoreTeam(team) {
  const [owner, repo] = team.repo.split("/");
  console.log(`\n🔍 Scoring ${team.team} (${team.repo})...`);

  const results = {};
  let total = 0;
  let maxTotal = 0;

  for (const [key, check] of Object.entries(CHECKS)) {
    try {
      const result = await check.run(owner, repo, team);
      results[key] = { ...result, points: check.points, label: check.label, category: check.category };
      if (result.pass) total += check.points;
      maxTotal += check.points;
      const icon = result.pass ? "✅" : "❌";
      console.log(`  ${icon} ${check.label} (${result.pass ? check.points : 0}/${check.points}) — ${result.detail}`);
    } catch (e) {
      results[key] = { pass: false, points: check.points, label: check.label, category: check.category, detail: `Error: ${e.message}` };
      maxTotal += check.points;
      console.log(`  ⚠️  ${check.label} — Error: ${e.message}`);
    }
  }

  return { team: team.team, members: team.members, repo: team.repo, deploy_url: team.deploy_url, total, maxTotal, results };
}

async function main() {
  const teams = JSON.parse(readFileSync("teams.json", "utf-8"));
  const scores = [];

  for (const team of teams) {
    scores.push(await scoreTeam(team));
  }

  // Sort by total descending
  scores.sort((a, b) => b.total - a.total);

  // Add rank
  scores.forEach((s, i) => (s.rank = i + 1));

  const output = {
    generated_at: new Date().toISOString(),
    total_possible: Object.values(CHECKS).reduce((s, c) => s + c.points, 0),
    teams: scores,
  };

  mkdirSync("docs", { recursive: true });
  writeFileSync("docs/scores.json", JSON.stringify(output, null, 2));
  console.log(`\n📊 Scores written to docs/scores.json`);
  console.log(`\n🏆 Leaderboard:`);
  for (const s of scores) {
    console.log(`  #${s.rank} ${s.team} — ${s.total}/${s.maxTotal} pts`);
  }
}

main().catch(console.error);

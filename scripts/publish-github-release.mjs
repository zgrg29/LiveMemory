#!/usr/bin/env node
/**
 * Create the GitHub release and upload release assets.
 *
 * Usage: GITHUB_TOKEN=... node scripts/publish-github-release.mjs \
 *   --tag v0.16.0 --title "..." --notes docs/release-notes/v0.16.0.md \
 *   --asset dist/release-v0.16.0/LiveMemory.exe --asset dist/release-v0.16.0/SHA256SUMS.txt
 *
 * The token is read from the environment and is never printed. Existing releases
 * are never overwritten: the script fails if the tag already has a release.
 */
import {readFileSync, statSync} from 'node:fs';
import {basename, resolve} from 'node:path';
import {createHash} from 'node:crypto';

const repo = process.env.GITHUB_REPOSITORY ?? 'zgrg29/LiveMemory';
const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error('GITHUB_TOKEN is required');
  process.exit(2);
}
const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
};
const tag = value('--tag');
const title = value('--title');
const notesFile = value('--notes');
const assets = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--asset') assets.push(resolve(args[i + 1]));
}
if (!tag || !title || !notesFile || assets.length === 0) {
  console.error('usage: --tag --title --notes --asset (repeatable)');
  process.exit(2);
}
const notes = readFileSync(resolve(notesFile), 'utf8');
const headers = {
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'LiveMemory-release-script'
};

async function api(path, {method = 'GET', body = null, contentType = 'application/json'} = {}) {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: body === null ? headers : {...headers, 'content-type': contentType},
    body: body === null ? undefined : (Buffer.isBuffer(body) ? body : JSON.stringify(body))
  });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return {status: response.status, json, text};
}

const existing = await api(`/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`);
if (existing.status === 200) {
  console.error(`a release for ${tag} already exists: ${existing.json.html_url}`);
  process.exit(1);
}
if (existing.status !== 404) {
  console.error(`release lookup failed: ${existing.status} ${existing.text.slice(0, 200)}`);
  process.exit(1);
}

const created = await api(`/repos/${repo}/releases`, {
  method: 'POST',
  body: {
    tag_name: tag,
    name: title,
    body: notes,
    draft: false,
    prerelease: false,
    generate_release_notes: false
  }
});
if (created.status !== 201) {
  console.error(`release creation failed: ${created.status} ${created.text.slice(0, 400)}`);
  process.exit(1);
}
const release = created.json;
console.log(`release created: ${release.html_url}`);

for (const file of assets) {
  const data = readFileSync(file);
  const name = basename(file);
  const upload = await fetch(`https://uploads.github.com/repos/${repo}/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/octet-stream',
      'content-length': String(data.length)
    },
    body: data
  });
  const uploadText = await upload.text();
  if (upload.status !== 201) {
    console.error(`asset upload failed (${name}): ${upload.status} ${uploadText.slice(0, 400)}`);
    process.exit(1);
  }
  const asset = JSON.parse(uploadText);
  const sha = createHash('sha256').update(data).digest('hex');
  console.log(`asset uploaded: ${asset.name} ${statSync(file).size} bytes sha256=${sha}`);
  if (asset.digest && asset.digest !== `sha256:${sha}`) {
    console.error(`asset digest mismatch: ${asset.digest} != sha256:${sha}`);
    process.exit(1);
  }
}

const verified = await api(`/repos/${repo}/releases/${release.id}`);
console.log(JSON.stringify({
  id: verified.json.id,
  tag: verified.json.tag_name,
  name: verified.json.name,
  draft: verified.json.draft,
  prerelease: verified.json.prerelease,
  published: verified.json.published_at,
  url: verified.json.html_url,
  assets: (verified.json.assets ?? []).map((asset) => ({
    name: asset.name,
    size: asset.size,
    state: asset.state,
    digest: asset.digest ?? null
  }))
}, null, 2));

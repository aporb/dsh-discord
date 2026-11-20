#!/usr/bin/env node
/**
 * verify-install.mjs — post-install gate for the locally forked Discord adapter.
 *
 * Checks the DSH desktop profile (filesystem only, no host process needed):
 *   (a) profile package.json exists and names the package in `dependencies`
 *       AND in `dsh.profile.bundles`
 *   (b) the mount row is registered: either the profile cordis.patch.yml
 *       carries it, or the installed bundle's own cordis.patch.yml does
 *       (profile-installed bundles carry their rows in the bundle patch).
 *   (c) installed node_modules/<package>/package.json exists; prints version;
 *       proves its `dependencies` carry no `@deepseek-ai/*` copies (host
 *       version gates disable rows that ship internal packages — AGENTS.md 16.106)
 *   (d) installed package ships lib/index.js, lib/client.js, cordis.patch.yml,
 *       locale/en.json, plus `dsh.bundle.patch` and `dsh.client` manifest fields
 *   (e) no duplicate older `@addozhang/dsh-discord` install or stale references
 *
 * Usage:
 *   node scripts/verify-install.mjs [--profile <dir>] [--package <name>] [--json]
 *                                   [--allow-shared-deepseek]
 *
 * `--allow-shared-deepseek` keeps the hard failure for host-internal
 * `@deepseek-ai/dsh-*` packages but accepts other `@deepseek-ai/*` runtime
 * libraries (e.g. `@deepseek-ai/schemastery`), which the repo's packaging guard
 * also permits. The default stays strict, per the install-gate spec.
 *
 * Exit: 0 all checks PASS, 1 any FAIL, 2 usage error.
 * Node 22 ESM, built-in modules only.
 */
import process from 'node:process'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '..')
const DEFAULT_PROFILE = path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
const DEFAULT_PACKAGE = '@aporb/dsh-discord'
const OLD_PACKAGE = '@addozhang/dsh-discord'
const API_HEADER = 'verify-install'

function usage() {
  return [
    'Usage: node scripts/verify-install.mjs [--profile <dir>] [--package <name>] [--json]',
    '                                        [--allow-shared-deepseek]',
    '',
    '  --profile <dir>           DSH profile directory (default: ~/.dsh/profiles/desktop)',
    '  --package <name>          package name to verify (default: @aporb/dsh-discord)',
    '  --allow-shared-deepseek   accept non-host @deepseek-ai/* libraries such as',
    '                            @deepseek-ai/schemastery; @deepseek-ai/dsh-* still FAILs',
    '  --json                    machine-readable output (no human PASS/FAIL lines)',
    '  -h, --help                show this help',
    '',
    'Exit codes: 0 = all checks PASS, 1 = at least one FAIL, 2 = usage error.',
  ].join('\n')
}

function expandHome(value) {
  if (value === '~') return os.homedir()
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2))
  return value
}

function parseArgs(argv) {
  const opts = {
    profile: DEFAULT_PROFILE,
    package: DEFAULT_PACKAGE,
    allowSharedDeepseek: false,
    json: false,
    help: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const take = (name) => {
      if (arg === name) {
        const value = argv[i + 1]
        if (value === undefined || value.startsWith('--')) throw new Error(`${name} requires a value`)
        i += 1
        return value
      }
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1)
      return null
    }
    if (arg === '--json') opts.json = true
    else if (arg === '--allow-shared-deepseek') opts.allowSharedDeepseek = true
    else if (arg === '--help' || arg === '-h') opts.help = true
    else {
      const profile = take('--profile')
      if (profile !== null) opts.profile = expandHome(profile)
      else {
        const pkg = take('--package')
        if (pkg !== null) opts.package = pkg
        else throw new Error(`unknown argument: ${arg}`)
      }
    }
  }
  if (opts.package.trim() === '') throw new Error('--package must not be empty')
  return opts
}

async function readText(file) {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

async function readJson(file) {
  const text = await readText(file)
  if (text === null) return { ok: false, error: 'file not found or unreadable' }
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch (error) {
    return { ok: false, error: `invalid JSON: ${error.message}` }
  }
}

async function pathInfo(target) {
  try {
    const info = await stat(target)
    return { exists: true, file: info.isFile(), size: info.size }
  } catch {
    return { exists: false, file: false, size: 0 }
  }
}

function packageDir(profileDir, name) {
  return path.join(profileDir, 'node_modules', ...name.split('/'))
}

/**
 * Scan a YAML patch as text (no YAML dependency allowed). Returns the mount
 * row for `id: dsh-discord`, with the `name:` value found in the same entry.
 * Entry boundary = next `- ...` line at the same or lower indentation; nested
 * config list items are more indented, so they do not split the entry.
 */
function findMountRow(text, rowId) {
  const lines = text.split(/\r?\n/)
  const idPattern = /^(\s*)-\s*id:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))\s*(?:#.*)?$/
  const namePattern = /(?:^|[\s{,])(?:name):\s*(?:"([^"]*)"|'([^']*)'|([^\s#,}]+))/
  let found = null
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(idPattern)
    if (match === null) continue
    const id = match[2] ?? match[3] ?? match[4]
    if (id !== rowId) continue
    const indent = match[1].length
    const block = [lines[i]]
    for (let j = i + 1; j < lines.length; j += 1) {
      const sibling = lines[j].match(/^(\s*)-\s+\S/)
      if (sibling !== null && sibling[1].length <= indent) break
      block.push(lines[j])
    }
    const nameMatch = block.join('\n').match(namePattern)
    found = {
      line: i + 1,
      name: nameMatch === null ? null : (nameMatch[1] ?? nameMatch[2] ?? nameMatch[3]),
      block: block.join('\n'),
    }
    break
  }
  return found
}

function patchIds(text) {
  const ids = []
  for (const line of text.split(/\r?\n/)) {
    // Only top-level patch entries are rows; nested `- id:` lines are data
    // (e.g. llm model ids) and would only make the evidence noisy.
    const match = line.match(/^-\s*id:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/)
    if (match !== null) ids.push(match[1] ?? match[2] ?? match[3])
  }
  return [...new Set(ids)]
}

const checks = []
function addCheck(letter, title, ok, evidence) {
  checks.push({ letter, title, ok: ok === true, evidence })
}

function entry(letter, title, ok, evidence) {
  addCheck(letter, title, ok, evidence)
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.help) {
    process.stdout.write(`${usage()}\n`)
    return 0
  }

  const profileDir = path.resolve(opts.profile)
  const packageName = opts.package
  const repoDoc = await readJson(path.join(REPO_ROOT, 'package.json'))
  const repoLabel = repoDoc.ok
    ? `${repoDoc.value.name ?? '(unnamed)'}@${repoDoc.value.version ?? '(no version)'}`
    : '(repo package.json unreadable)'
  const profilePackagePath = path.join(profileDir, 'package.json')
  const profilePatchPath = path.join(profileDir, 'cordis.patch.yml')

  // (a) profile package.json -------------------------------------------------
  const profileDoc = await readJson(profilePackagePath)
  let profileText = null
  if (profileDoc.ok) {
    const doc = profileDoc.value
    const dependency = doc?.dependencies?.[packageName]
    const bundles = doc?.dsh?.profile?.bundles
    const inBundles = Array.isArray(bundles) && bundles.includes(packageName)
    const evidence = [
      `profile package.json: ${profilePackagePath}`,
      dependency === undefined
        ? `dependencies["${packageName}"]: MISSING`
        : `dependencies["${packageName}"] = ${JSON.stringify(dependency)}`,
      inBundles
        ? `dsh.profile.bundles includes "${packageName}" (${bundles.length} bundles)`
        : `dsh.profile.bundles: MISSING "${packageName}" (${Array.isArray(bundles) ? bundles.join(', ') || '(empty)' : 'not an array'})`,
    ]
    entry('a', 'profile package.json lists the package in dependencies and dsh.profile.bundles', dependency !== undefined && inBundles, evidence)
  } else {
    entry('a', 'profile package.json lists the package in dependencies and dsh.profile.bundles', false, [
      `profile package.json: ${profilePackagePath}`,
      `error: ${profileDoc.error}`,
    ])
  }

  // (b) profile patch layer carries the mount row ---------------------------
  profileText = await readText(profilePatchPath)
  if (profileText === null) {
    entry('b', `profile cordis.patch.yml carries the row (id: dsh-discord, name: ${packageName})`, false, [
      `profile cordis.patch.yml: ${profilePatchPath}`,
      'error: file not found or unreadable',
    ])
  } else {
    let row = null
    let source = 'profile patch'
    const ids = patchIds(profileText)
    const evidence = [`profile cordis.patch.yml: ${profilePatchPath} (${profileText.split(/\r?\n/).length} lines)`]
    // A profile-installed BUNDLE carries its rows in its own patch file; the
    // profile patch then holds user overrides (`- id: dsh-discord` with config
    // or `disabled`, and no `name`). Check the bundle patch first, then fall
    // back to a full mount row in the profile patch.
    const bundlePatchPath = path.join(profileDir, 'node_modules', ...packageName.split('/'), 'cordis.patch.yml')
    const bundleText = await readText(bundlePatchPath)
    if (bundleText !== null) {
      const bundleRow = findMountRow(bundleText, 'dsh-discord')
      if (bundleRow !== null) {
        row = bundleRow
        source = `bundle patch (${bundlePatchPath})`
      }
    }
    if (row === null) {
      const profileRow = findMountRow(profileText, 'dsh-discord')
      if (profileRow !== null && profileRow.name !== null) {
        row = profileRow
        source = 'profile patch'
      }
    }
    if (row === null) {
      evidence.push(`row "id: dsh-discord": MISSING in profile patch and bundle patch`)
      evidence.push(`profile row ids present: ${ids.length > 0 ? ids.join(', ') : '(none found)'}`)
    } else {
      evidence.push(`row found in ${source} at line ${row.line}, id: dsh-discord`)
      evidence.push(
        row.name === packageName
          ? `name: ${packageName}`
          : `name: ${row.name === null ? 'MISSING' : JSON.stringify(row.name)} (expected ${JSON.stringify(packageName)})`,
      )
    }
    entry('b', `mount row registered (profile patch or bundle patch: id dsh-discord, name ${packageName})`, row !== null && row.name === packageName, evidence)
  }

  // (c) installed package: version + no internal @deepseek-ai dependencies ---
  const installedDir = packageDir(profileDir, packageName)
  const installedDoc = await readJson(path.join(installedDir, 'package.json'))
  let installed = null
  if (!installedDoc.ok) {
    entry('c', 'installed package has a valid package.json and no @deepseek-ai/* runtime dependencies', false, [
      `installed package: ${installedDir}`,
      `error: ${installedDoc.error}`,
    ])
  } else {
    installed = installedDoc.value
    const dependencies = installed?.dependencies ?? {}
    const dependencyNames = Object.keys(dependencies)
    const offenders = dependencyNames.filter((name) => name.startsWith('@deepseek-ai/'))
    const hostInternals = offenders.filter((name) => name.startsWith('@deepseek-ai/dsh-'))
    const sharedLibraries = offenders.filter((name) => !name.startsWith('@deepseek-ai/dsh-'))
    const peerNames = Object.keys(installed?.peerDependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'))
    const evidence = [
      `installed package: ${installedDir}`,
      `version: ${installed?.version ?? '(missing version)'}`,
      `dependencies: ${dependencyNames.length > 0 ? dependencyNames.join(', ') : '(none)'}`,
    ]
    if (offenders.length === 0) {
      evidence.push('no @deepseek-ai/* in dependencies')
    } else {
      for (const name of hostInternals) {
        evidence.push(`HOST-INTERNAL dependency (hard FAIL): ${name}@${dependencies[name]}`)
      }
      for (const name of sharedLibraries) {
        evidence.push(`shared @deepseek-ai/* library: ${name}@${dependencies[name]} (not host-internal)`)
      }
      if (sharedLibraries.length > 0) {
        evidence.push(
          opts.allowSharedDeepseek
            ? '--allow-shared-deepseek given: non-host @deepseek-ai/* libraries accepted'
            : 'strict mode: any @deepseek-ai/* dependency FAILs; pass --allow-shared-deepseek to accept non-host libraries only',
        )
      }
    }
    if (peerNames.length > 0) evidence.push(`peerDependencies (allowed, not counted): ${peerNames.join(', ')}`)
    const deepseekDepsOk =
      hostInternals.length === 0 && (sharedLibraries.length === 0 || opts.allowSharedDeepseek)
    entry('c', 'installed package has a valid package.json and no @deepseek-ai/* runtime dependencies', deepseekDepsOk, evidence)
  }

  // (d) installed payload files + manifest fields ---------------------------
  const requiredFiles = ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'locale/en.json']
  const fileEvidence = []
  let filesOk = true
  for (const relative of requiredFiles) {
    const info = await pathInfo(path.join(installedDir, relative))
    if (!info.exists || !info.file) {
      filesOk = false
      fileEvidence.push(`${relative}: MISSING`)
    } else if (info.size === 0) {
      filesOk = false
      fileEvidence.push(`${relative}: 0 bytes (empty)`)
    } else {
      fileEvidence.push(`${relative}: ${info.size} bytes`)
    }
  }
  const dsh = installed?.dsh ?? {}
  const bundlePatch = dsh?.bundle?.patch
  const clientField = dsh?.client
  const bundlePatchOk = typeof bundlePatch === 'string' && bundlePatch.trim() !== ''
  let bundlePatchTargetOk = false
  if (bundlePatchOk) {
    const target = path.resolve(installedDir, bundlePatch)
    const info = await pathInfo(target)
    bundlePatchTargetOk = info.exists && info.file
    fileEvidence.push(
      `dsh.bundle.patch = ${JSON.stringify(bundlePatch)} -> ${target}${bundlePatchTargetOk ? '' : ' (MISSING)'}`,
    )
  } else {
    fileEvidence.push('dsh.bundle.patch: MISSING')
  }
  const clientOk = clientField !== null && typeof clientField === 'object' && !Array.isArray(clientField)
  fileEvidence.push(
    clientOk
      ? `dsh.client: present (${Object.keys(clientField).join(', ')})`
      : 'dsh.client: MISSING (expected an object)',
  )
  entry(
    'd',
    'installed package ships lib/index.js, lib/client.js, cordis.patch.yml, locale/en.json and dsh.bundle.patch + dsh.client',
    filesOk && bundlePatchOk && bundlePatchTargetOk && clientOk,
    [`installed package: ${installedDir}`, ...fileEvidence],
  )

  // (e) no duplicate older @addozhang install / stale references ------------
  const oldDir = packageDir(profileDir, OLD_PACKAGE)
  const oldInfo = await pathInfo(oldDir)
  const staleRefs = []
  if (profileDoc.ok) {
    const doc = profileDoc.value
    if (doc?.dependencies?.[OLD_PACKAGE] !== undefined) {
      staleRefs.push(`profile package.json dependencies still references ${OLD_PACKAGE}`)
    }
    const bundles = doc?.dsh?.profile?.bundles
    if (Array.isArray(bundles) && bundles.includes(OLD_PACKAGE)) {
      staleRefs.push(`profile package.json dsh.profile.bundles still lists ${OLD_PACKAGE}`)
    }
  }
  if (profileText !== null) {
    profileText.split(/\r?\n/).forEach((line, index) => {
      if (line.includes(OLD_PACKAGE)) staleRefs.push(`profile cordis.patch.yml:${index + 1} references ${OLD_PACKAGE}`)
    })
  }
  const evidence = [
    oldInfo.exists
      ? `node_modules/${OLD_PACKAGE}: PRESENT (duplicate older install, ${oldInfo.size} bytes)`
      : `node_modules/${OLD_PACKAGE}: absent`,
    ...(staleRefs.length > 0 ? staleRefs : ['no stale references to the older package name']),
  ]
  entry(
    'e',
    `no duplicate older ${OLD_PACKAGE} install or stale reference`,
    !oldInfo.exists && staleRefs.length === 0,
    [`profile: ${profileDir}`, ...evidence],
  )

  // Report ------------------------------------------------------------------
  const passed = checks.filter((check) => check.ok).length
  const failed = checks.length - passed
  const ok = failed === 0
  const summary = { ok, profile: profileDir, package: packageName, repo: repoLabel, checks, passed, failed }

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
  } else {
    const lines = [
      `${API_HEADER} — profile: ${profileDir}`,
      `package: ${packageName} (repo: ${repoLabel})`,
      '',
    ]
    for (const check of checks) {
      lines.push(`[${check.ok ? 'PASS' : 'FAIL'}] (${check.letter}) ${check.title}`)
      for (const item of check.evidence) lines.push(`       ${item}`)
    }
    lines.push('')
    lines.push(`${passed} passed, ${failed} failed`)
    lines.push(ok ? 'RESULT: PASS (exit 0)' : 'RESULT: FAIL (exit 1)')
    process.stdout.write(`${lines.join('\n')}\n`)
  }
  return ok ? 0 : 1
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error) => {
    process.stderr.write(`verify-install: ${error.message}\n\n${usage()}\n`)
    process.exitCode = 2
  })
